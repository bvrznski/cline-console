#!/usr/bin/env python3
"""
Cline Console Database Viewer - A GUI for viewing the cline-console SQLite database.
This is the main entry point that initializes and runs the application.
"""

import sys
from db_view.gui import Application


def main():
    """Main entry point for the database viewer."""
    app = Application()
    app.run()


if __name__ == "__main__":
    main()