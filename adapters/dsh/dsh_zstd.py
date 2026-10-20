"""A small Zstandard decoder in pure Python (RFC 8878), stdlib only, for Python 3.9 and later.

Why it exists: DSH writes every session as Zstandard frames (session.v4.jsonl.zstd) and the Python standard library only
gets a zstd module in 3.14. The capture hook has to read that log on whatever Python the machine has, so the decoder lives
here instead of depending on a zstd command line tool.

    frames, end = decode_frames(data, start)

`frames` is a list with one bytes object per complete frame, `end` is the offset just after the last complete frame. A frame
that is still being written (the data ends inside it) is left out and `end` stays before it, so the next call picks it up.
Skippable frames are stepped over. A frame that cannot be decoded is skipped when another frame follows it, and otherwise
left alone, so nothing here raises on a bad file.

It decodes what a normal encoder writes: raw, RLE and compressed blocks, Huffman and FSE entropy coding, repeat offsets,
and tables reused from the previous block. It does not support dictionaries and does not verify the content checksum
(it does check the declared content size).
"""
from __future__ import annotations

MAGIC = b"\x28\xb5\x2f\xfd"
SKIPPABLE = 0x184D2A50
MAX_BLOCK = 128 * 1024


class Truncated(Exception):
    """The data ends inside a frame: more bytes may still arrive."""


class Corrupt(Exception):
    """The frame is not valid Zstandard."""


# ---------------------------------------------------------------- bit readers

def _peek(data: bytes, bit: int, n: int) -> int:
    """n bits (little endian bit order) starting at bit position `bit`. Bits past the end read as zero."""
    return (int.from_bytes(data[bit >> 3:(bit + n + 7) >> 3], "little") >> (bit & 7)) & ((1 << n) - 1)


class Backward:
    """A bit stream read from its end towards its start. The last byte holds a marker bit (the highest set bit) and the
    padding above it, the real data is everything below the marker."""

    def __init__(self, data: bytes):
        if not data or data[-1] == 0:
            raise Corrupt("bit stream has no end marker")
        self.data = data
        self.pos = (len(data) - 1) * 8 + data[-1].bit_length() - 1  # bits still unread

    def peek(self, n: int) -> int:
        if n == 0:
            return 0
        start = self.pos - n
        if start >= 0:
            return _peek(self.data, start, n)
        real = n + start  # bits that exist, the ones below the start of the stream read as zero
        return (_peek(self.data, 0, real) << -start) if real > 0 else 0

    def read(self, n: int) -> int:
        value = self.peek(n)
        self.pos -= n
        return value

    def overrun(self) -> bool:
        return self.pos < 0


# ---------------------------------------------------------------- FSE

class FSE:
    """A decoding table: for each state the symbol, the number of bits to read next and the base of the next state."""

    def __init__(self, counts: list, log: int):
        size = 1 << log
        symbol = [0] * size
        high = size - 1
        nxt = []
        for s, c in enumerate(counts):
            if c == -1:
                symbol[high] = s
                high -= 1
                nxt.append(1)
            else:
                nxt.append(c)
        step = (size >> 1) + (size >> 3) + 3
        pos = 0
        for s, c in enumerate(counts):
            for _ in range(max(c, 0)):
                symbol[pos] = s
                pos = (pos + step) & (size - 1)
                while pos > high:
                    pos = (pos + step) & (size - 1)
        bits, base = [0] * size, [0] * size
        for state in range(size):
            s = symbol[state]
            n = nxt[s]
            nxt[s] += 1
            bits[state] = log - (n.bit_length() - 1)
            base[state] = (n << bits[state]) - size
        self.log, self.symbol, self.bits, self.base = log, symbol, bits, base

    @classmethod
    def rle(cls, symbol: int) -> "FSE":
        t = cls.__new__(cls)
        t.log, t.symbol, t.bits, t.base = 0, [symbol], [0], [0]
        return t


def read_fse(data: bytes, pos: int, max_symbol: int, max_log: int) -> tuple:
    """Parse a table description at data[pos:]. Returns (FSE, position after it)."""
    bit = pos * 8
    log = _peek(data, bit, 4) + 5
    bit += 4
    if log > max_log:
        raise Corrupt("FSE accuracy log too large")
    remaining, threshold, nbits = (1 << log) + 1, 1 << log, log + 1
    counts: list = []
    previous_zero = False
    while remaining > 1 and len(counts) <= max_symbol:
        if previous_zero:
            n0 = len(counts)
            while _peek(data, bit, 16) == 0xFFFF:
                n0 += 24
                bit += 16
            while _peek(data, bit, 2) == 3:
                n0 += 3
                bit += 2
            n0 += _peek(data, bit, 2)
            bit += 2
            if n0 > max_symbol + 1:
                raise Corrupt("FSE symbol range")
            counts.extend([0] * (n0 - len(counts)))
        limit = (2 * threshold - 1) - remaining
        low = _peek(data, bit, nbits - 1)
        if low < limit:
            count = low
            bit += nbits - 1
        else:
            count = _peek(data, bit, nbits)
            bit += nbits
            if count >= threshold:
                count -= limit
        count -= 1
        remaining -= abs(count)
        counts.append(count)
        previous_zero = count == 0
        while remaining < threshold:
            nbits -= 1
            threshold >>= 1
    if remaining != 1 or len(counts) > max_symbol + 1:
        raise Corrupt("FSE counts do not add up")
    end = (bit + 7) >> 3
    if end > len(data):
        raise Corrupt("FSE description runs past its data")
    return FSE(counts, log), end


LL_DEFAULT = ([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6)
ML_DEFAULT = ([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
               1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1], 6)
OF_DEFAULT = ([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5)

LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024,
           2048, 4096, 8192, 16384, 32768, 65536]
LL_BITS = [0] * 16 + [1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
ML_BASE = list(range(3, 35)) + [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539]
ML_BITS = [0] * 32 + [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]

PREDEFINED = {}


def _predefined(kind: str) -> FSE:
    if kind not in PREDEFINED:
        counts, log = {"ll": LL_DEFAULT, "ml": ML_DEFAULT, "of": OF_DEFAULT}[kind]
        PREDEFINED[kind] = FSE(counts, log)
    return PREDEFINED[kind]


# ---------------------------------------------------------------- Huffman literals

class Huffman:
    def __init__(self, weights: list):
        """`weights` holds every symbol's weight except the last, which the format implies."""
        total = sum(1 << (w - 1) for w in weights if w)
        if total == 0:
            raise Corrupt("empty Huffman table")
        max_bits = total.bit_length()
        rest = (1 << max_bits) - total
        if max_bits > 11 or rest & (rest - 1):
            raise Corrupt("bad Huffman weights")
        weights = weights + [rest.bit_length()]
        self.max_bits = max_bits
        self.symbol = [0] * (1 << max_bits)
        self.bits = [0] * (1 << max_bits)
        pos = 0
        for w in range(1, max_bits + 1):
            for s, sw in enumerate(weights):
                if sw == w:
                    count = 1 << (w - 1)
                    self.symbol[pos:pos + count] = [s] * count
                    self.bits[pos:pos + count] = [max_bits + 1 - w] * count
                    pos += count

    def decode(self, data: bytes, count: int) -> bytes:
        stream = Backward(data)
        out = bytearray()
        symbol, bits, max_bits = self.symbol, self.bits, self.max_bits
        for _ in range(count):
            index = stream.peek(max_bits)
            out.append(symbol[index])
            stream.pos -= bits[index]
        if stream.pos != 0:
            raise Corrupt("Huffman stream not fully used")
        return bytes(out)


def read_huffman(data: bytes, pos: int) -> tuple:
    """Parse a Huffman tree description at data[pos:]. Returns (Huffman, position after it)."""
    if pos >= len(data):
        raise Corrupt("missing Huffman tree")
    header = data[pos]
    pos += 1
    if header >= 128:
        count = header - 127
        size = (count + 1) // 2
        raw = data[pos:pos + size]
        if len(raw) < size:
            raise Corrupt("short Huffman tree")
        weights = []
        for byte in raw:
            weights += [byte >> 4, byte & 15]
        return Huffman(weights[:count]), pos + size
    comp = data[pos:pos + header]
    if len(comp) < header or header == 0:
        raise Corrupt("short Huffman tree")
    table, used = read_fse(comp, 0, 12, 6)
    stream = Backward(comp[used:])
    s1, s2 = stream.read(table.log), stream.read(table.log)
    weights: list = []
    while True:
        weights.append(table.symbol[s1])
        s1 = table.base[s1] + stream.read(table.bits[s1])
        if stream.overrun():
            weights.append(table.symbol[s2])
            break
        weights.append(table.symbol[s2])
        s2 = table.base[s2] + stream.read(table.bits[s2])
        if stream.overrun():
            weights.append(table.symbol[s1])
            break
        if len(weights) > 255:
            raise Corrupt("too many Huffman weights")
    return Huffman(weights), pos + header


# ---------------------------------------------------------------- blocks

class State:
    """What carries from one block to the next inside a frame."""

    def __init__(self):
        self.huffman = None
        self.tables = {"ll": None, "of": None, "ml": None}
        self.offsets = [1, 4, 8]


def read_literals(data: bytes, pos: int, state: State) -> tuple:
    byte0 = data[pos]
    kind = byte0 & 3
    form = (byte0 >> 2) & 3
    if kind < 2:  # raw or RLE
        if form in (0, 2):
            size, head = byte0 >> 3, 1
        elif form == 1:
            size, head = (byte0 >> 4) + (data[pos + 1] << 4), 2
        else:
            size, head = (byte0 >> 4) + (data[pos + 1] << 4) + (data[pos + 2] << 12), 3
        pos += head
        if kind == 0:
            return data[pos:pos + size], pos + size
        return data[pos:pos + 1] * size, pos + 1
    streams = 1 if form == 0 else 4
    head, width = (3, 10) if form < 2 else ((4, 14) if form == 2 else (5, 18))
    word = int.from_bytes(data[pos:pos + head], "little") >> 4
    regen, comp = word & ((1 << width) - 1), (word >> width) & ((1 << width) - 1)
    pos += head
    body = data[pos:pos + comp]
    if len(body) < comp:
        raise Corrupt("literals run past the block")
    if kind == 2:
        state.huffman, used = read_huffman(body, 0)
        body = body[used:]
    elif state.huffman is None:
        raise Corrupt("literals reuse a table that does not exist")
    huff = state.huffman
    if streams == 1:
        return huff.decode(body, regen), pos + comp
    if len(body) < 6:
        raise Corrupt("short literal streams")
    s1, s2, s3 = (int.from_bytes(body[i:i + 2], "little") for i in (0, 2, 4))
    each = (regen + 3) // 4
    cuts = [6, 6 + s1, 6 + s1 + s2, 6 + s1 + s2 + s3, len(body)]
    counts = [each, each, each, regen - 3 * each]
    if cuts[3] > len(body) or counts[3] < 0:
        raise Corrupt("literal stream sizes")
    return b"".join(huff.decode(body[cuts[i]:cuts[i + 1]], counts[i]) for i in range(4)), pos + comp


def read_table(mode: int, kind: str, data: bytes, pos: int, state: State, max_symbol: int, max_log: int) -> int:
    if mode == 0:
        state.tables[kind] = _predefined(kind)
    elif mode == 1:
        state.tables[kind] = FSE.rle(data[pos])
        pos += 1
    elif mode == 2:
        state.tables[kind], pos = read_fse(data, pos, max_symbol, max_log)
    elif state.tables[kind] is None:
        raise Corrupt("repeat of a table that does not exist")
    return pos


def run_sequences(out: bytearray, lits: bytes, data: bytes, pos: int, state: State) -> None:
    first = data[pos]
    pos += 1
    if first == 0:
        out += lits
        return
    if first < 128:
        count = first
    elif first < 255:
        count = ((first - 128) << 8) + data[pos]
        pos += 1
    else:
        count = data[pos] + (data[pos + 1] << 8) + 0x7F00
        pos += 2
    modes = data[pos]
    pos += 1
    pos = read_table(modes >> 6, "ll", data, pos, state, 35, 9)
    pos = read_table((modes >> 4) & 3, "of", data, pos, state, 31, 8)
    pos = read_table((modes >> 2) & 3, "ml", data, pos, state, 52, 9)
    ll, of, ml = state.tables["ll"], state.tables["of"], state.tables["ml"]
    stream = Backward(data[pos:])
    sl, so, sm = stream.read(ll.log), stream.read(of.log), stream.read(ml.log)
    reps = state.offsets
    lp = 0
    for i in range(count):
        oc, mc, lc = of.symbol[so], ml.symbol[sm], ll.symbol[sl]
        offset_value = (1 << oc) + stream.read(oc)
        match_len = ML_BASE[mc] + stream.read(ML_BITS[mc])
        lit_len = LL_BASE[lc] + stream.read(LL_BITS[lc])
        if i < count - 1:
            sl = ll.base[sl] + stream.read(ll.bits[sl])
            sm = ml.base[sm] + stream.read(ml.bits[sm])
            so = of.base[so] + stream.read(of.bits[so])
        if offset_value > 3:
            offset = offset_value - 3
            reps[:] = [offset, reps[0], reps[1]]
        else:
            index = offset_value - 1 + (1 if lit_len == 0 else 0)
            if index == 3:
                offset = reps[0] - 1
                if offset <= 0:
                    raise Corrupt("repeat offset of zero")
                reps[:] = [offset, reps[0], reps[1]]
            else:
                offset = reps[index]
                if index:
                    reps.insert(0, reps.pop(index))
        if lp + lit_len > len(lits):
            raise Corrupt("sequence reads past the literals")
        out += lits[lp:lp + lit_len]
        lp += lit_len
        if offset > len(out):
            raise Corrupt("match points before the start")
        start = len(out) - offset
        if offset >= match_len:
            out += out[start:start + match_len]
        else:
            chunk = bytes(out[start:])
            out += (chunk * (match_len // offset + 1))[:match_len]
    if stream.pos != 0:
        raise Corrupt("sequence stream not fully used")
    out += lits[lp:]


def decode_block(out: bytearray, data: bytes, state: State) -> None:
    lits, pos = read_literals(data, 0, state)
    run_sequences(out, lits, data, pos, state)


# ---------------------------------------------------------------- frames

def decode_frame(data: bytes, pos: int) -> tuple:
    """One frame starting at data[pos]. Returns (decoded bytes, position after the frame)."""
    def need(end: int) -> None:
        if end > len(data):
            raise Truncated("frame is not complete yet")

    need(pos + 6)
    flags = data[pos + 4]
    pos += 5
    single, checksum, dict_flag = (flags >> 5) & 1, (flags >> 2) & 1, flags & 3
    if flags & 0x08:
        raise Corrupt("reserved bit set")
    if dict_flag:
        raise Corrupt("dictionaries are not supported")
    if not single:
        pos += 1  # window descriptor, the whole frame is held in memory so the window size is not needed
    size_bytes = {0: 1 if single else 0, 1: 2, 2: 4, 3: 8}[flags >> 6]
    need(pos + size_bytes)
    declared = int.from_bytes(data[pos:pos + size_bytes], "little") + (256 if size_bytes == 2 else 0) if size_bytes else None
    pos += size_bytes
    out, state = bytearray(), State()
    while True:
        need(pos + 3)
        header = int.from_bytes(data[pos:pos + 3], "little")
        pos += 3
        last, kind, size = header & 1, (header >> 1) & 3, header >> 3
        if size > MAX_BLOCK:
            raise Corrupt("block too large")
        if kind == 1:
            need(pos + 1)
            out += data[pos:pos + 1] * size
            pos += 1
        else:
            need(pos + size)
            if kind == 0:
                out += data[pos:pos + size]
            elif kind == 2:
                try:
                    decode_block(out, data[pos:pos + size], state)
                except (IndexError, ValueError, KeyError) as exc:
                    raise Corrupt("block does not decode: %s" % type(exc).__name__) from None
            else:
                raise Corrupt("reserved block type")
            pos += size
        if last:
            break
    if checksum:
        need(pos + 4)
        pos += 4
    if declared is not None and declared != len(out):
        raise Corrupt("decoded size differs from the declared size")
    return bytes(out), pos


def decode_frames(data: bytes, start: int = 0) -> tuple:
    """Every complete frame in data[start:]. Returns ([frame bytes], offset after the last complete frame)."""
    frames: list = []
    pos = end = start
    while pos + 4 <= len(data):
        magic = int.from_bytes(data[pos:pos + 4], "little")
        try:
            if magic & 0xFFFFFFF0 == SKIPPABLE:
                if pos + 8 > len(data):
                    break
                pos += 8 + int.from_bytes(data[pos + 4:pos + 8], "little")
                if pos > len(data):
                    break
            elif data[pos:pos + 4] == MAGIC:
                frame, pos = decode_frame(data, pos)
                frames.append(frame)
            else:
                raise Corrupt("not a frame")
        except Truncated:
            break
        except Corrupt:
            nxt = data.find(MAGIC, pos + 1)
            if nxt < 0:
                break  # nothing after it to resume at, leave the bad frame alone
            pos = nxt
        end = pos
    return frames, end
