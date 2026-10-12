#!/usr/bin/env python3
"""
GUI module for Cline Console Database Viewer.
Provides the user interface using tkinter, independent of database logic.
"""

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext, filedialog
from typing import Optional, List, Dict, Any
import json
import os

# Import from same package (works when run as module or directly)
try:
    from .db import DatabaseManager
except ImportError:
    from db_view.db import DatabaseManager


class DarkModeMixin:
    """Mixin class to apply dark mode styling to tkinter widgets."""

    def __init__(self):
        self.dark_mode_colors = {
            'bg': '#2b2b2b',
            'fg': '#ffffff',
            'entry_bg': '#3c3f41',
            'entry_fg': '#ffffff',
            'tree_bg': '#2d2d2d',
            'tree_fg': '#e0e0e0',
            'tree_selected': '#3a6da5',
            'frame_bg': '#2b2b2b',
            'label_bg': '#2b2b2b',
            'button_bg': '#444444',
            'button_fg': '#ffffff',
            'combobox_bg': '#3c3f41',
            'combobox_fg': '#ffffff',
        }

    def apply_dark_mode(self, root: tk.Tk):
        """Apply dark mode styling to all widgets in the root window."""
        root.configure(bg=self.dark_mode_colors['bg'])

        style = ttk.Style()
        try:
            style.theme_use('clam')
        except tk.TclError:
            pass

        style.configure('.',
                       background=self.dark_mode_colors['bg'],
                       foreground=self.dark_mode_colors['fg'],
                       fieldbackground=self.dark_mode_colors['entry_bg'])

        style.configure('TFrame', background=self.dark_mode_colors['frame_bg'])
        style.configure('TLabel', background=self.dark_mode_colors['label_bg'], foreground=self.dark_mode_colors['fg'])
        style.configure('TButton', background=self.dark_mode_colors['button_bg'],
                       foreground=self.dark_mode_colors['button_fg'], padding=6)
        style.map('TButton', background=[('active', self.dark_mode_colors['button_bg'])])
        style.configure('TEntry', background=self.dark_mode_colors['entry_bg'],
                       foreground=self.dark_mode_colors['entry_fg'])
        style.configure('TCombobox', background=self.dark_mode_colors['combobox_bg'],
                       foreground=self.dark_mode_colors['combobox_fg'])
        style.configure('TNotebook', background=self.dark_mode_colors['bg'], borderwidth=0)
        style.configure('TNotebook.Tab', background=self.dark_mode_colors['frame_bg'],
                       foreground=self.dark_mode_colors['fg'], padding=[10, 4])
        style.map('TNotebook.Tab', background=[('selected', self.dark_mode_colors['bg'])],
                 foreground=[('selected', '#ffffff')])
        style.configure('Treeview', background=self.dark_mode_colors['tree_bg'],
                       foreground=self.dark_mode_colors['tree_fg'], rowheight=25)
        style.map('Treeview', background=[('selected', self.dark_mode_colors['tree_selected'])])
        style.configure('TScrollbar', background=self.dark_mode_colors['frame_bg'])
        style.configure('TPanedWindow', background=self.dark_mode_colors['frame_bg'])


class PreferencesDialog:
    """Dialog for application preferences."""

    def __init__(self, parent: tk.Tk, config: Dict[str, Any]):
        self.parent = parent
        self.config = config.copy()
        self.result = None

        self.dialog = tk.Toplevel(parent)
        self.dialog.title("Preferences")
        self.dialog.geometry("600x500")
        self.dialog.transient(parent)
        self.dialog.grab_set()

        self._setup_ui()

    def _setup_ui(self):
        """Setup preferences UI."""
        notebook = ttk.Notebook(self.dialog)
        notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        # General tab
        general_frame = ttk.Frame(notebook)
        notebook.add(general_frame, text="General")
        self._setup_general_tab(general_frame)

        # Database tab
        db_frame = ttk.Frame(notebook)
        notebook.add(db_frame, text="Database")
        self._setup_database_tab(db_frame)

        # Queue tab
        queue_frame = ttk.Frame(notebook)
        notebook.add(queue_frame, text="Queue")
        self._setup_queue_tab(queue_frame)

        # Buttons frame
        buttons_frame = ttk.Frame(self.dialog)
        buttons_frame.pack(fill=tk.X, padx=10, pady=(0, 10))

        ttk.Button(buttons_frame, text="Save", command=self._save).pack(side=tk.RIGHT, padx=5)
        ttk.Button(buttons_frame, text="Cancel", command=self._cancel).pack(side=tk.RIGHT, padx=5)

    def _setup_general_tab(self, parent: tk.Frame):
        """Setup general preferences tab."""
        frame = ttk.LabelFrame(parent, text="Appearance")
        frame.pack(fill=tk.X, padx=10, pady=10)

        ttk.Label(frame, text="Theme:").pack(anchor='w', padx=5, pady=5)
        self.theme_var = tk.StringVar(value=self.config.get('theme', 'dark'))
        theme_combo = ttk.Combobox(frame, textvariable=self.theme_var,
                                  values=['dark', 'light'])
        theme_combo.pack(fill=tk.X, padx=5, pady=5)

        frame2 = ttk.LabelFrame(parent, text="Window")
        frame2.pack(fill=tk.X, padx=10, pady=10)

        ttk.Label(frame2, text="Default window width:").pack(anchor='w', padx=5, pady=3)
        self.width_var = tk.StringVar(value=str(self.config.get('window_width', 1400)))
        ttk.Entry(frame2, textvariable=self.width_var).pack(fill=tk.X, padx=5, pady=3)

        ttk.Label(frame2, text="Default window height:").pack(anchor='w', padx=5, pady=3)
        self.height_var = tk.StringVar(value=str(self.config.get('window_height', 900)))
        ttk.Entry(frame2, textvariable=self.height_var).pack(fill=tk.X, padx=5, pady=3)

    def _setup_database_tab(self, parent: tk.Frame):
        """Setup database preferences tab."""
        frame = ttk.LabelFrame(parent, text="Database Settings")
        frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        ttk.Label(frame, text="Default Database Path:").pack(anchor='w', padx=5, pady=3)
        self.db_path_var = tk.StringVar(value=self.config.get('db_path', ''))
        path_frame = ttk.Frame(frame)
        path_frame.pack(fill=tk.X, padx=5, pady=3)

        ttk.Entry(path_frame, textvariable=self.db_path_var).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(path_frame, text="Browse...", command=self._browse_db).pack(side=tk.RIGHT)

    def _setup_queue_tab(self, parent: tk.Frame):
        """Setup queue preferences tab."""
        frame = ttk.LabelFrame(parent, text="Queue Settings")
        frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        # Inter-task delay
        ttk.Label(frame, text="Inter-task delay (ms):").pack(anchor='w', padx=5, pady=3)
        self.inter_task_delay_var = tk.StringVar(value=str(self.config.get('inter_task_delay_ms', 15000)))
        ttk.Entry(frame, textvariable=self.inter_task_delay_var).pack(fill=tk.X, padx=5, pady=3)

        # Terminal stability
        ttk.Label(frame, text="Terminal stability (ms):").pack(anchor='w', padx=5, pady=3)
        self.terminal_stability_var = tk.StringVar(value=str(self.config.get('terminal_stability_ms', 15000)))
        ttk.Entry(frame, textvariable=self.terminal_stability_var).pack(fill=tk.X, padx=5, pady=3)

        # Max unchanged correction rounds
        ttk.Label(frame, text="Max unchanged correction rounds:").pack(anchor='w', padx=5, pady=3)
        self.max_unchanged_rounds_var = tk.StringVar(value=str(self.config.get('max_unchanged_correction_rounds', 5)))
        ttk.Entry(frame, textvariable=self.max_unchanged_rounds_var).pack(fill=tk.X, padx=5, pady=3)

    def _browse_db(self):
        """Browse for database file."""
        file_path = filedialog.askopenfilename(
            title="Select Database File",
            filetypes=[("SQLite databases", "*.sqlite3 *.db"), ("All files", "*.*")]
        )
        if file_path:
            self.db_path_var.set(file_path)

    def _save(self):
        """Save preferences."""
        self.result = {
            'theme': self.theme_var.get(),
            'window_width': int(self.width_var.get()),
            'window_height': int(self.height_var.get()),
            'db_path': self.db_path_var.get().strip() or None,
            'inter_task_delay_ms': int(self.inter_task_delay_var.get()),
            'terminal_stability_ms': int(self.terminal_stability_var.get()),
            'max_unchanged_correction_rounds': int(self.max_unchanged_rounds_var.get())
        }
        self.dialog.destroy()

    def _cancel(self):
        """Cancel preferences."""
        self.result = None
        self.dialog.destroy()


class ConfigManager:
    """Manages application configuration."""

    def __init__(self, config_path: Optional[str] = None):
        self.config_path = config_path or os.path.join(
            os.path.expanduser('~'), '.config', 'cline-console-gui', 'config.json'
        )
        self.config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file."""
        try:
            if os.path.exists(self.config_path):
                with open(self.config_path, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
        return self._get_default_config()

    def _get_default_config(self) -> Dict[str, Any]:
        """Get default configuration."""
        return {
            'theme': 'dark',
            'window_width': 1400,
            'window_height': 900,
            'db_path': None,
            'inter_task_delay_ms': 15000,
            'terminal_stability_ms': 15000,
            'max_unchanged_correction_rounds': 5
        }

    def save(self):
        """Save configuration to file."""
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, 'w') as f:
            json.dump(self.config, f, indent=2)


class TaskDetailsWindow:
    """Window to display detailed information about a task."""

    def __init__(self, parent: tk.Tk, db_manager: DatabaseManager, task_id: str):
        self.parent = parent
        self.db_manager = db_manager
        self.task_id = task_id

        self.window = tk.Toplevel(parent)
        self.window.title(f"Task Details: {task_id[:12]}...")
        self.window.geometry("900x700")

        self._setup_ui()
        self._load_data()

    def _setup_ui(self):
        """Setup the UI components."""
        notebook = ttk.Notebook(self.window)
        notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        task_frame = ttk.Frame(notebook)
        notebook.add(task_frame, text="Task Information")

        runs_frame = ttk.Frame(notebook)
        notebook.add(runs_frame, text="Runs")

        events_frame = ttk.Frame(notebook)
        notebook.add(events_frame, text="Events")

        prompts_frame = ttk.Frame(notebook)
        notebook.add(prompts_frame, text="Prompt Snapshots")

        self._setup_task_info(task_frame)
        self._setup_runs(runs_frame)
        self._setup_events(events_frame)
        self._setup_prompts(prompts_frame)

    def _setup_task_info(self, parent: tk.Frame):
        """Setup task information display."""
        text_widget = scrolledtext.ScrolledText(parent, wrap=tk.WORD, width=80, height=30,
                                               bg='#2d2d2d', fg='#e0e0e0',
                                               insertbackground='#ffffff')
        text_widget.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.task_info_text = text_widget

    def _setup_runs(self, parent: tk.Frame):
        """Setup runs display."""
        columns = ('id', 'attempt', 'cline_session_id', 'state', 'dispatched_at', 'finished_at')
        tree = ttk.Treeview(parent, columns=columns, show='headings')

        for col in columns:
            tree.heading(col, text=col.replace('_', ' ').title())
            tree.column(col, width=120)

        tree.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.runs_tree = tree

    def _setup_events(self, parent: tk.Frame):
        """Setup events display."""
        columns = ('id', 'event_type', 'source', 'truth_kind', 'occurred_at')
        tree = ttk.Treeview(parent, columns=columns, show='headings')

        for col in columns:
            tree.heading(col, text=col.replace('_', ' ').title())
            tree.column(col, width=120)

        tree.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.events_tree = tree

    def _setup_prompts(self, parent: tk.Frame):
        """Setup prompt snapshots display."""
        columns = ('id', 'prompt_kind', 'byte_length', 'source', 'created_at')
        tree = ttk.Treeview(parent, columns=columns, show='headings')

        for col in columns:
            tree.heading(col, text=col.replace('_', ' ').title())
            tree.column(col, width=120)

        tree.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.prompts_tree = tree

    def _load_data(self):
        """Load and display task data from database."""
        details = self.db_manager.get_task_details(self.task_id)
        if not details:
            messagebox.showerror("Error", f"Task not found: {self.task_id}", parent=self.window)
            self.window.destroy()
            return

        self._display_task_info(details)

        for run in details.get('runs', []):
            self.runs_tree.insert('', tk.END, values=(
                run['id'][:12] + '...',
                run['attempt'],
                run.get('cline_session_id', ''),
                run['state'],
                run['dispatched_at'],
                run.get('finished_at', '')
            ))

        for event in details.get('events', []):
            self.events_tree.insert('', tk.END, values=(
                event['id'][:12] + '...',
                event['event_type'],
                event['source'],
                event['truth_kind'],
                event['occurred_at']
            ))

        for snapshot in details.get('prompt_snapshots', []):
            self.prompts_tree.insert('', tk.END, values=(
                snapshot['id'][:12] + '...',
                snapshot['prompt_kind'],
                snapshot['byte_length'],
                snapshot.get('source', ''),
                snapshot['created_at']
            ))

    def _display_task_info(self, details: Dict[str, Any]):
        """Display task information in text widget."""
        info = []
        for key, value in details.items():
            if key in ('runs', 'events', 'prompt_snapshots'):
                continue

            formatted_value = value
            if isinstance(value, dict):
                formatted_value = str(value)
            elif isinstance(value, str) and len(value) > 100:
                formatted_value = value[:97] + '...'

            info.append(f"{key}: {formatted_value}")

        self.task_info_text.insert('1.0', '\n'.join(info))
        self.task_info_text.config(state=tk.DISABLED)


class Application:
    """Main application class for the Cline Console Database Viewer."""

    def __init__(self, db_path: Optional[str] = None):
        self.root = tk.Tk()
        self.root.title("Cline Console Database Viewer")

        # Initialize config manager
        self.config_manager = ConfigManager()
        self.config = self.config_manager.config

        # Apply window size from config
        width = self.config.get('window_width', 1400)
        height = self.config.get('window_height', 900)
        self.root.geometry(f"{width}x{height}")

        # Initialize dark mode mixin
        self._dark_mode = DarkModeMixin()

        # Initialize database manager (decoupled from GUI)
        db_path = db_path or self.config.get('db_path')
        self.db_manager = DatabaseManager(db_path)

        # Track current view state
        self.current_state_filter = tk.StringVar(value="all")
        self.current_workspace_filter = tk.StringVar(value="")

        # UI widgets
        self.task_tree: Optional[ttk.Treeview] = None
        self.queue_tree: Optional[ttk.Treeview] = None
        self.workspace_tree: Optional[ttk.Treeview] = None
        self.stats_labels: Dict[str, ttk.Label] = {}
        self._queue_frame: Optional[tk.Frame] = None

        self._setup_ui()
        self._load_data()

    def _setup_ui(self):
        """Setup the main UI components."""
        # Apply dark mode to root window
        self._dark_mode.apply_dark_mode(self.root)

        # Menu bar with dark mode colors
        menubar = tk.Menu(self.root, bg='#2b2b2b', fg='#ffffff', activebackground='#444444',
                         activeforeground='#ffffff')
        self.root.config(menu=menubar)

        file_menu = tk.Menu(menubar, tearoff=0, bg='#2b2b2b', fg='#ffffff',
                           activebackground='#444444', activeforeground='#ffffff')
        menubar.add_cascade(label="File", menu=file_menu)
        file_menu.add_command(label="Open Database...", command=self._open_database)
        file_menu.add_separator()
        file_menu.add_command(label="Export Tasks (CSV)", command=self._export_tasks_csv)
        file_menu.add_separator()
        file_menu.add_command(label="Preferences...", command=self._show_preferences)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.quit)

        view_menu = tk.Menu(menubar, tearoff=0, bg='#2b2b2b', fg='#ffffff',
                           activebackground='#444444', activeforeground='#ffffff')
        menubar.add_cascade(label="View", menu=view_menu)
        view_menu.add_command(label="Refresh", command=self._refresh_data)

        help_menu = tk.Menu(menubar, tearoff=0, bg='#2b2b2b', fg='#ffffff',
                           activebackground='#444444', activeforeground='#ffffff')
        menubar.add_cascade(label="Help", menu=help_menu)
        help_menu.add_command(label="About", command=self._show_about)

        # Tab notebook for different views
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # Tasks tab
        tasks_frame = ttk.Frame(self.notebook)
        self.notebook.add(tasks_frame, text="Tasks")
        self._setup_tasks_view(tasks_frame)

        # Queue tab
        queue_frame = ttk.Frame(self.notebook)
        self.notebook.add(queue_frame, text="Queue Entries")
        self._setup_queue_view(queue_frame)

        # Workspaces tab
        workspaces_frame = ttk.Frame(self.notebook)
        self.notebook.add(workspaces_frame, text="Workspaces")
        self._setup_workspaces_view(workspaces_frame)

        # Statistics panel at bottom
        stats_panel = ttk.LabelFrame(self.root, text="Statistics")
        stats_panel.pack(fill=tk.X, padx=5, pady=(0, 5))

        self.stats_labels = {}
        stats_layout = [
            ("Total Tasks", "total_tasks"),
            ("Total Workspaces", "total_workspaces"),
            ("Recent Tasks (24h)", "recent_tasks")
        ]

        for i, (label_text, stat_key) in enumerate(stats_layout):
            frame = ttk.Frame(stats_panel)
            frame.pack(side=tk.LEFT, padx=10, pady=5)

            ttk.Label(frame, text=label_text, font=('Arial', 9, 'bold')).pack(anchor='w')
            value_label = ttk.Label(frame, text="Loading...", foreground='#aaaaaa')
            value_label.pack(anchor='w')
            self.stats_labels[stat_key] = value_label

        # Queue state stats
        queue_frame_stats = ttk.Frame(stats_panel)
        queue_frame_stats.pack(side=tk.LEFT, padx=10, pady=5, fill=tk.X)

        ttk.Label(queue_frame_stats, text="Queue by State:", font=('Arial', 9, 'bold')).pack(anchor='w')

    def _setup_tasks_view(self, parent: tk.Frame):
        """Setup tasks view."""
        filter_frame = ttk.Frame(parent)
        filter_frame.pack(fill=tk.X, padx=5, pady=5)

        ttk.Label(filter_frame, text="State:").pack(side=tk.LEFT, padx=(0, 5))
        state_combo = ttk.Combobox(
            filter_frame,
            textvariable=self.current_state_filter,
            values=["all", "queued", "running", "completed", "failed", "skipped"],
            width=15
        )
        state_combo.pack(side=tk.LEFT, padx=(0, 10))
        state_combo.bind('<<ComboboxSelected>>', lambda e: self._load_data())

        ttk.Label(filter_frame, text="Workspace:").pack(side=tk.LEFT, padx=(0, 5))
        workspace_entry = ttk.Entry(filter_frame, textvariable=self.current_workspace_filter, width=30)
        workspace_entry.pack(side=tk.LEFT, padx=(0, 10))
        workspace_entry.bind('<Return>', lambda e: self._load_data())

        refresh_btn = ttk.Button(filter_frame, text="Refresh", command=self._refresh_data)
        refresh_btn.pack(side=tk.RIGHT)

        task_list_frame = ttk.Frame(parent)
        task_list_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        columns = ('id', 'workspace', 'kind', 'title', 'state', 'updated_at')
        self.task_tree = ttk.Treeview(task_list_frame, columns=columns, show='headings',
                                     style='Dark.Treeview')

        for col in columns:
            header = col.replace('_', ' ').title()
            self.task_tree.heading(col, text=header, command=lambda c=col: self._sort_tasks(c))
            self.task_tree.column(col, width=100)

        self.task_tree.column('id', width=200)
        self.task_tree.column('workspace', width=250)
        self.task_tree.column('title', width=300)

        task_vsb = ttk.Scrollbar(task_list_frame, orient=tk.VERTICAL, command=self.task_tree.yview)
        task_hsb = ttk.Scrollbar(task_list_frame, orient=tk.HORIZONTAL, command=self.task_tree.xview)
        self.task_tree.configure(yscrollcommand=task_vsb.set, xscrollcommand=task_hsb.set)

        self.task_tree.grid(row=0, column=0, sticky='nsew')
        task_vsb.grid(row=0, column=1, sticky='ns')
        task_hsb.grid(row=1, column=0, sticky='ew')

        task_list_frame.rowconfigure(0, weight=1)
        task_list_frame.columnconfigure(0, weight=1)

        self.task_tree.bind('<Double-1>', lambda e: self._show_task_details())
        self.task_tree.bind('<Return>', lambda e: self._show_task_details())

    def _setup_queue_view(self, parent: tk.Frame):
        """Setup queue entries view."""
        filter_frame = ttk.Frame(parent)
        filter_frame.pack(fill=tk.X, padx=5, pady=5)

        ttk.Label(filter_frame, text="Workspace:").pack(side=tk.LEFT, padx=(0, 5))
        workspace_entry = ttk.Entry(filter_frame, width=30)
        workspace_entry.pack(side=tk.LEFT, padx=(0, 10))
        workspace_entry.bind('<Return>', lambda e: self._load_queue_data())

        refresh_btn = ttk.Button(filter_frame, text="Refresh", command=self._refresh_queue_data)
        refresh_btn.pack(side=tk.RIGHT)

        queue_list_frame = ttk.Frame(parent)
        queue_list_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        columns = ('id', 'workspace', 'kind', 'state', 'position', 'queued_at')
        self.queue_tree = ttk.Treeview(queue_list_frame, columns=columns, show='headings',
                                      style='Dark.Treeview')

        for col in columns:
            header = col.replace('_', ' ').title()
            self.queue_tree.heading(col, text=header)
            self.queue_tree.column(col, width=120)

        self.queue_tree.column('id', width=200)
        self.queue_tree.column('workspace', width=250)

        queue_vsb = ttk.Scrollbar(queue_list_frame, orient=tk.VERTICAL, command=self.queue_tree.yview)
        queue_hsb = ttk.Scrollbar(queue_list_frame, orient=tk.HORIZONTAL, command=self.queue_tree.xview)
        self.queue_tree.configure(yscrollcommand=queue_vsb.set, xscrollcommand=queue_hsb.set)

        self.queue_tree.grid(row=0, column=0, sticky='nsew')
        queue_vsb.grid(row=0, column=1, sticky='ns')
        queue_hsb.grid(row=1, column=0, sticky='ew')

        queue_list_frame.rowconfigure(0, weight=1)
        queue_list_frame.columnconfigure(0, weight=1)

    def _setup_workspaces_view(self, parent: tk.Frame):
        """Setup workspaces view."""
        filter_frame = ttk.Frame(parent)
        filter_frame.pack(fill=tk.X, padx=5, pady=5)

        refresh_btn = ttk.Button(filter_frame, text="Refresh", command=self._refresh_workspace_data)
        refresh_btn.pack(side=tk.RIGHT)

        workspace_list_frame = ttk.Frame(parent)
        workspace_list_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        columns = ('id', 'canonical_path', 'first_seen_at', 'last_seen_at')
        self.workspace_tree = ttk.Treeview(workspace_list_frame, columns=columns, show='headings',
                                          style='Dark.Treeview')

        for col in columns:
            header = col.replace('_', ' ').title()
            self.workspace_tree.heading(col, text=header)
            self.workspace_tree.column(col, width=150)

        self.workspace_tree.column('id', width=200)
        self.workspace_tree.column('canonical_path', width=400)

        ws_vsb = ttk.Scrollbar(workspace_list_frame, orient=tk.VERTICAL, command=self.workspace_tree.yview)
        ws_hsb = ttk.Scrollbar(workspace_list_frame, orient=tk.HORIZONTAL, command=self.workspace_tree.xview)
        self.workspace_tree.configure(yscrollcommand=ws_vsb.set, xscrollcommand=ws_hsb.set)

        self.workspace_tree.grid(row=0, column=0, sticky='nsew')
        ws_vsb.grid(row=0, column=1, sticky='ns')
        ws_hsb.grid(row=1, column=0, sticky='ew')

        workspace_list_frame.rowconfigure(0, weight=1)
        workspace_list_frame.columnconfigure(0, weight=1)

    def _load_data(self):
        """Load data from database and update UI."""
        try:
            workspace = self.current_workspace_filter.get() or None
            state = self.current_state_filter.get() if self.current_state_filter.get() != "all" else None

            tasks = self.db_manager.query_tasks(
                workspace=workspace,
                limit=100,
                state_filter=state
            )

            for item in self.task_tree.get_children():
                self.task_tree.delete(item)

            for task in tasks:
                self.task_tree.insert('', tk.END, values=(
                    task['id'][:12] + '...',
                    task.get('workspace', '')[:40],
                    task.get('kind', ''),
                    task.get('title', '')[:50],
                    task.get('state', ''),
                    task.get('updated_at', '')
                ))

            stats = self.db_manager.get_statistics()
            for key, label in self.stats_labels.items():
                value = stats.get(key, 0)
                label.config(text=str(value), foreground='#ffffff')

        except FileNotFoundError as e:
            messagebox.showerror("Database Error", str(e), parent=self.root)

    def _load_queue_data(self):
        """Load queue entries from database."""
        try:
            workspace = self.current_workspace_filter.get() or None
            queue_entries = self.db_manager.get_queue_entries(workspace=workspace)

            for item in self.queue_tree.get_children():
                self.queue_tree.delete(item)

            for entry in queue_entries:
                self.queue_tree.insert('', tk.END, values=(
                    entry['id'][:12] + '...',
                    entry.get('workspace', '')[:40],
                    entry.get('kind', ''),
                    entry.get('state', ''),
                    entry.get('position', ''),
                    entry.get('queued_at', '')
                ))
        except FileNotFoundError as e:
            messagebox.showerror("Database Error", str(e), parent=self.root)

    def _load_workspace_data(self):
        """Load workspaces from database."""
        try:
            workspaces = self.db_manager.get_workspaces()

            for item in self.workspace_tree.get_children():
                self.workspace_tree.delete(item)

            for ws in workspaces:
                self.workspace_tree.insert('', tk.END, values=(
                    ws['id'][:12] + '...',
                    ws.get('canonical_path', '')[:60],
                    ws.get('first_seen_at', ''),
                    ws.get('last_seen_at', '')
                ))
        except FileNotFoundError as e:
            messagebox.showerror("Database Error", str(e), parent=self.root)

    def _refresh_data(self):
        """Refresh all data from database."""
        self._load_data()
        if hasattr(self, 'notebook') and self.notebook.index('current') == 1:
            self._load_queue_data()
        elif hasattr(self, 'notebook') and self.notebook.index('current') == 2:
            self._load_workspace_data()

    def _refresh_queue_data(self):
        """Refresh queue data."""
        self._load_queue_data()

    def _refresh_workspace_data(self):
        """Refresh workspace data."""
        self._load_workspace_data()

    def _show_task_details(self):
        """Show details for selected task."""
        selection = self.task_tree.selection()
        if not selection:
            return

        item = self.task_tree.item(selection[0])
        values = item.get('values', [])

        if len(values) > 0:
            task_id = values[0].rstrip('...')
            TaskDetailsWindow(self.root, self.db_manager, task_id)

    def _sort_tasks(self, column: str):
        """Sort tasks by the specified column."""
        items = [(self.task_tree.set(k, column), k) for k in self.task_tree.get_children('')]

        if column == 'updated_at':
            items.sort(key=lambda x: x[0], reverse=True)
        else:
            items.sort()

        for index, (val, k) in enumerate(items):
            self.task_tree.move(k, '', index)

    def _export_tasks_csv(self):
        """Export tasks to CSV file."""
        try:
            tasks = self.db_manager.query_tasks(limit=10000)

            if not tasks:
                messagebox.showinfo("Export", "No tasks to export.", parent=self.root)
                return

            file_path = filedialog.asksaveasfilename(
                title="Export Tasks",
                defaultextension=".csv",
                filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
            )

            if not file_path:
                return

            import csv
            with open(file_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)

                writer.writerow(['id', 'workspace', 'kind', 'title', 'state',
                               'source_path', 'origin', 'created_at', 'updated_at',
                               'dispatched_at', 'finished_at', 'error'])

                for task in tasks:
                    writer.writerow([
                        task['id'],
                        task.get('workspace', ''),
                        task.get('kind', ''),
                        task.get('title', ''),
                        task.get('state', ''),
                        task.get('source_path', ''),
                        task.get('origin', ''),
                        task.get('created_at', ''),
                        task.get('updated_at', ''),
                        task.get('dispatched_at', ''),
                        task.get('finished_at', ''),
                        task.get('error', '')
                    ])

            messagebox.showinfo("Export", f"Successfully exported {len(tasks)} tasks to:\n{file_path}", parent=self.root)

        except Exception as e:
            messagebox.showerror("Export Error", str(e), parent=self.root)

    def _show_preferences(self):
        """Show preferences dialog."""
        dialog = PreferencesDialog(self.root, self.config)
        self.root.wait_window(dialog.dialog)

        if dialog.result:
            # Update config with new values
            self.config.update(dialog.result)

            # Save config
            self.config_manager.config = self.config
            self.config_manager.save()

            # Apply window size changes
            width = self.config.get('window_width', 1400)
            height = self.config.get('window_height', 900)
            self.root.geometry(f"{width}x{height}")

    def _open_database(self):
        """Open a database file dialog."""
        file_path = filedialog.askopenfilename(
            title="Select Database File",
            filetypes=[("SQLite databases", "*.sqlite3 *.db"), ("All files", "*.*")]
        )

        if file_path:
            try:
                self.db_manager = DatabaseManager(file_path)
                self._load_data()
                self._load_queue_data()
                self._load_workspace_data()
            except Exception as e:
                messagebox.showerror("Error", f"Failed to open database: {e}", parent=self.root)

    def _show_about(self):
        """Show about dialog."""
        about_text = """Cline Console Database Viewer - Full Edition

A GUI tool for viewing the cline-console SQLite database.

Features:
- View tasks, queue entries, and events
- Filter by state and workspace
- Detailed task information with runs and events
- Statistics overview
- Dark mode interface
- Export to CSV functionality
- Multiple view tabs (Tasks, Queue, Workspaces)
- Preferences dialog for configuration

Database is decoupled from the GUI for clean architecture."""

        messagebox.showinfo("About", about_text, parent=self.root)

    def run(self):
        """Run the application main loop."""
        self.root.mainloop()

    def quit(self):
        """Quit the application."""
        self.root.quit()