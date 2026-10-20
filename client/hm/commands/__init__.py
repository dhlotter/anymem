"""Command modules, one file per command, so a command is added with a module and a launcher in skills/anymem/scripts.

A module is a command when it defines:
    COMMAND = "name"                 the subcommand word
    HELP = "one line"                shown in the script help
    def register(parser): ...        add the command's arguments to its argparse subparser
    def run(namespace): ...          do the work, return an exit code (None means 0)

Commands print to stdout, errors to stderr.
"""
