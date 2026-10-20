---
type: tool_used
tool: Bash
input_match: 'scripts/remember\.py[\s\S]+name: [\s\S]+metadata:[\s\S]+type: (feedback|project)'
min: 1
---
Pass when the assistant runs `remember.py` (the anymem skill's script, not a command called `anymem`) with a frontmatter block (name, metadata, and type feedback or project) that holds the correction. The command, heredoc or JSON-encoded, must contain all three parts in order. Both types carry Why and How to apply in the skill, so either passes.
