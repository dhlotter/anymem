"""anymem client core: configuration, the Worker REST helper and the command modules the skill scripts run.

Everything here is stdlib only and runs on Python 3.9, so the scripts, the hooks and the per harness adapters can share it.
Hooks add this folder to sys.path (see hooks/_path.py) and `from hm import config, api`.
"""
