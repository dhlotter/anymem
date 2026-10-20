---
type: tool_order
before: { tool: Bash, input_match: 'scripts/recall\.py' }
after: { tool: Bash, input_match: 'scripts/forget\.py' }
---
Pass when a `recall.py` call comes before the first `forget.py` call. Both must be present.
