#!/usr/bin/env python3
"""
Database module for Cline Console Database Viewer.
Provides database access layer independent of any UI framework.
"""

import sqlite3
import os
from typing import Optional, List, Dict, Any


class DatabaseManager:
    """
    Manages SQLite database connections and queries for cline-console.

    This class is decoupled from any GUI framework - it only handles
    database operations and returns plain Python data structures.
    """

    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the database manager.

        Args:
            db_path: Path to the SQLite database file. If None, uses default path.
        """
        self.db_path = db_path or self._get_default_db_path()

    def _get_default_db_path(self) -> str:
        """Get the default database path based on XDG_DATA_HOME or home directory."""
        xdg_data = os.environ.get('XDG_DATA_HOME', '').strip()
        if not xdg_data:
            xdg_data = os.path.join(os.path.expanduser('~'), '.local', 'share')
        return os.path.join(xdg_data, 'cline-console', 'history.sqlite3')

    def connect(self) -> sqlite3.Connection:
        """
        Create and return a database connection.

        Returns:
            sqlite3.Connection: A connected database connection object.

        Raises:
            FileNotFoundError: If the database file does not exist.
        """
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(f"Database file not found: {self.db_path}")

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def get_tables(self) -> List[str]:
        """
        Get list of all tables in the database.

        Returns:
            List of table names sorted alphabetically.
        """
        with self.connect() as conn:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
            return [row[0] for row in cursor.fetchall()]

    def get_table_columns(self, table_name: str) -> List[str]:
        """
        Get column names for a specific table.

        Args:
            table_name: Name of the table to inspect.

        Returns:
            List of column names.
        """
        with self.connect() as conn:
            cursor = conn.execute(f"PRAGMA table_info({table_name})")
            return [row[1] for row in cursor.fetchall()]

    def query_tasks(
        self,
        workspace: Optional[str] = None,
        limit: int = 100,
        state_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Query tasks with optional filtering.

        Args:
            workspace: Optional workspace path to filter by.
            limit: Maximum number of results to return.
            state_filter: Optional state filter (queued, running, completed, failed, cleared).

        Returns:
            List of task dictionaries with all relevant fields.
        """
        with self.connect() as conn:
            sql = """
                SELECT t.id, w.canonical_path AS workspace, t.kind, t.title,
                       t.source_path, t.origin, t.created_at, t.updated_at,
                       q.state, q.cline_session_id, q.dispatched_at, q.finished_at, q.error
                FROM tasks t
                JOIN workspaces w ON w.id = t.workspace_id
                LEFT JOIN queue_entries q ON q.task_id = t.id
            """

            conditions = []
            params = []

            if workspace:
                conditions.append("w.canonical_path = ?")
                params.append(workspace)

            if state_filter and state_filter != "all":
                conditions.append("q.state = ?")
                params.append(state_filter)

            if conditions:
                sql += " WHERE " + " AND ".join(conditions)

            sql += " ORDER BY t.updated_at DESC LIMIT ?"
            params.append(limit)

            cursor = conn.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]

    def get_task_details(self, task_id: str) -> Optional[Dict[str, Any]]:
        """
        Get detailed information about a specific task.

        Args:
            task_id: The ID of the task to retrieve.

        Returns:
            Dictionary containing task details with runs, events, and prompt_snapshots,
            or None if task not found.
        """
        with self.connect() as conn:
            # Get task info
            task = conn.execute(
                "SELECT t.*, w.canonical_path AS workspace FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?",
                (task_id,)
            ).fetchone()

            if not task:
                return None

            result = dict(task)

            # Get runs
            runs = conn.execute(
                "SELECT * FROM task_runs WHERE task_id=? ORDER BY dispatched_at",
                (task_id,)
            ).fetchall()
            result['runs'] = [dict(row) for row in runs]

            # Get events
            events = conn.execute(
                "SELECT * FROM events WHERE task_id=? OR queue_item_id=? ORDER BY occurred_at",
                (task_id, task_id)
            ).fetchall()
            result['events'] = [dict(row) for row in events]

            # Get prompt snapshots
            snapshots = conn.execute(
                "SELECT * FROM prompt_snapshots WHERE task_id = ? ORDER BY created_at",
                (task_id,)
            ).fetchall()
            result['prompt_snapshots'] = [dict(row) for row in snapshots]

            return result

    def get_queue_entries(self, workspace: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Get queue entries with optional workspace filtering.

        Args:
            workspace: Optional workspace path to filter by.

        Returns:
            List of queue entry dictionaries.
        """
        with self.connect() as conn:
            sql = """
                SELECT q.*, w.canonical_path AS workspace
                FROM queue_entries q
                JOIN workspaces w ON w.id = q.workspace_id
            """

            if workspace:
                sql += " WHERE w.canonical_path = ?"
                params = (workspace,)
            else:
                params = ()

            sql += " ORDER BY q.position, q.queued_at DESC"

            cursor = conn.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]

    def get_workspaces(self) -> List[Dict[str, Any]]:
        """
        Get all registered workspaces.

        Returns:
            List of workspace dictionaries.
        """
        with self.connect() as conn:
            cursor = conn.execute(
                "SELECT * FROM workspaces ORDER BY last_seen_at DESC"
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_events(self, task_id: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Get events with optional task filtering.

        Args:
            task_id: Optional task ID to filter by.
            limit: Maximum number of results to return.

        Returns:
            List of event dictionaries.
        """
        with self.connect() as conn:
            if task_id:
                sql = """
                    SELECT * FROM events
                    WHERE task_id = ? OR queue_item_id = ?
                    ORDER BY occurred_at DESC
                    LIMIT ?
                """
                cursor = conn.execute(sql, (task_id, task_id, limit))
            else:
                sql = "SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?"
                cursor = conn.execute(sql, (limit,))

            return [dict(row) for row in cursor.fetchall()]

    def get_statistics(self) -> Dict[str, Any]:
        """
        Get database statistics.

        Returns:
            Dictionary containing various database statistics.
        """
        with self.connect() as conn:
            stats = {}

            # Count tasks
            stats['total_tasks'] = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]

            # Count workspaces
            stats['total_workspaces'] = conn.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0]

            # Count queue entries by state
            cursor = conn.execute("""
                SELECT state, COUNT(*) as count
                FROM queue_entries
                GROUP BY state
            """)
            stats['queue_by_state'] = {row[0]: row[1] for row in cursor.fetchall()}

            return stats

    def get_all_queue_states(self) -> List[str]:
        """
        Get all unique queue states in the database.

        Returns:
            List of unique state names.
        """
        with self.connect() as conn:
            cursor = conn.execute(
                "SELECT DISTINCT state FROM queue_entries ORDER BY state"
            )
            return [row[0] for row in cursor.fetchall()]