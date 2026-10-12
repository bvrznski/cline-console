"""
Cline Console Database Viewer - A GUI for viewing the cline-console SQLite database.

This package provides a decoupled architecture with separate modules for:
- db: Database access layer (independent of any UI framework)
- gui: Graphical user interface using tkinter
"""

from .db import DatabaseManager
from .gui import Application, TaskDetailsWindow

__version__ = "1.0.0"