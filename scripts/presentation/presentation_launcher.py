from __future__ import annotations

import dataclasses
import json
import os
import queue
import subprocess
import sys
import threading
import uuid
import webbrowser
from pathlib import Path
from shutil import which
from tkinter import BooleanVar, StringVar, Tk, messagebox
from tkinter import scrolledtext, ttk
from typing import Mapping, Sequence

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))

from deployment_profile import DeploymentProfile, load_deployment_profile
from windows_credentials import WindowsCredentialStore


EVENT_SCHEMA = "bdde38.presentation.event.v1"
REPO_ROOT = SCRIPT_DIRECTORY.parents[1]
DEFAULT_DEPLOYMENT_PROFILE = load_deployment_profile(REPO_ROOT)
CREDENTIAL_TARGET = DEFAULT_DEPLOYMENT_PROFILE.credential_target
SSH_USERNAME = DEFAULT_DEPLOYMENT_PROFILE.ssh_username
STAGES = (
    "preflight",
    "tailscale_route",
    "cluster_access",
    "hdfs_yarn",
    "spark_thrift",
    "ssh_tunnel",
    "docker_postgis",
    "spatial_dependencies",
    "docker_app",
    "application_health",
    "smoke_test",
    "ready",
)
STAGE_LABELS = {
    "preflight": "本機檢查",
    "tailscale_route": "Tailscale 路由",
    "cluster_access": "叢集連線",
    "hdfs_yarn": "HDFS / YARN",
    "spark_thrift": "Spark Thrift / Iceberg",
    "ssh_tunnel": "SSH Tunnel",
    "docker_postgis": "Docker / PostGIS",
    "spatial_dependencies": "空間資料 / EEZ",
    "docker_app": "Docker / App Runtime",
    "application_health": "應用健康",
    "smoke_test": "五項資料驗收",
    "ready": "展示環境就緒",
}
STATUS_LABELS = {
    "waiting": "等待",
    "running": "執行中",
    "ok": "完成",
    "failed": "失敗",
    "info": "檢查中",
    "log": "執行中",
}
EXIT_MESSAGES = {
    0: "操作完成",
    1: "環境尚未完全就緒",
    2: "本機先備條件未通過",
    3: "已有另一個展示操作執行中",
    10: "無法連線至 SSH 或叢集",
    11: "HDFS 或 YARN 未就緒",
    12: "Spark Thrift 或 Iceberg 驗證失敗",
    13: "SSH Tunnel 建立失敗",
    20: "Docker Compose 啟動失敗",
    21: "應用健康檢查失敗",
    22: "五項資料驗收失敗",
    23: "空間資料或 EEZ 準備失敗",
}


@dataclasses.dataclass(frozen=True)
class PortConfig:
    tunnel: int = DEFAULT_DEPLOYMENT_PROFILE.local_tunnel_port
    http: int = DEFAULT_DEPLOYMENT_PROFILE.host_http_port
    developer: int = DEFAULT_DEPLOYMENT_PROFILE.host_developer_port

    def validate(self) -> None:
        values = (self.tunnel, self.http, self.developer)
        if any(port < 1 or port > 65535 for port in values):
            raise ValueError("連接埠必須介於 1 到 65535。")
        if len(set(values)) != len(values):
            raise ValueError("Tunnel、網站與開發者服務必須使用不同連接埠。")

    def arguments(self) -> list[str]:
        self.validate()
        return [
            "--tunnel-port",
            str(self.tunnel),
            "--http-port",
            str(self.http),
            "--developer-port",
            str(self.developer),
        ]


def build_controller_command(
    python_executable: str,
    controller: Path,
    command: str,
    ports: PortConfig,
    *,
    deployment_profile: DeploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
    open_browser: bool = False,
    dry_run: bool = False,
) -> list[str]:
    if command not in {"start", "stop", "status", "test"}:
        raise ValueError(f"Unsupported controller command: {command}")
    argv = [
        python_executable,
        str(controller),
        "--json",
        "--deployment-profile",
        str(deployment_profile.path),
        command,
    ]
    if command in {"start", "status", "test"}:
        argv.extend(ports.arguments())
    if command == "start" and open_browser:
        argv.append("--open-browser")
    if command in {"start", "test"} and dry_run:
        argv.append("--dry-run")
    return argv


def parse_controller_line(line: str) -> dict[str, object]:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return {
            "schema": EVENT_SCHEMA,
            "command": "controller",
            "stage": "preflight",
            "status": "log",
            "message": line,
            "details": {},
        }
    if not isinstance(event, dict) or event.get("schema") != EVENT_SCHEMA:
        return {
            "schema": EVENT_SCHEMA,
            "command": "controller",
            "stage": "preflight",
            "status": "log",
            "message": line,
            "details": {},
        }
    return event


def find_csharp_compiler() -> Path | None:
    discovered = which("csc.exe")
    if discovered:
        return Path(discovered)
    windows_dir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    for candidate in (
        windows_dir / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe",
        windows_dir / "Microsoft.NET" / "Framework" / "v4.0.30319" / "csc.exe",
    ):
        if candidate.is_file():
            return candidate
    return None


def ensure_askpass_helper(source: Path, output: Path) -> Path:
    if output.is_file() and output.stat().st_mtime_ns >= source.stat().st_mtime_ns:
        return output
    compiler = find_csharp_compiler()
    if compiler is None:
        raise RuntimeError("找不到 Windows C# 編譯器，無法安全建立 SSH AskPass helper。")
    output.parent.mkdir(parents=True, exist_ok=True)
    creation_flags = 0
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        creation_flags = subprocess.CREATE_NO_WINDOW
    result = subprocess.run(
        [
            str(compiler),
            "/nologo",
            "/target:exe",
            "/optimize+",
            f"/out:{output}",
            str(source),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        shell=False,
        creationflags=creation_flags,
    )
    if result.returncode != 0 or not output.is_file():
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"SSH AskPass helper 建立失敗：{detail or 'unknown compiler error'}")
    return output


def build_askpass_environment(helper: Path, credential_target: str) -> dict[str, str]:
    return {
        "BDDE38_SSH_CREDENTIAL_TARGET": credential_target,
        "SSH_ASKPASS": str(helper),
        "SSH_ASKPASS_REQUIRE": "force",
        "DISPLAY": "bdde38",
    }


class ControllerProcess:
    def __init__(self, messages: queue.Queue[tuple[str, object]]) -> None:
        self.messages = messages
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()

    @property
    def active(self) -> bool:
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def start(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        command: str,
        extra_environment: Mapping[str, str] | None = None,
    ) -> None:
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                raise RuntimeError("A controller command is already running.")
            environment = os.environ.copy()
            environment["PYTHONUNBUFFERED"] = "1"
            if extra_environment:
                environment.update(extra_environment)
            creation_flags = 0
            if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
                creation_flags = subprocess.CREATE_NO_WINDOW
            self._process = subprocess.Popen(
                list(argv),
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
                shell=False,
                creationflags=creation_flags,
            )
            process = self._process
        threading.Thread(
            target=self._read_output,
            args=(process, command),
            name=f"presentation-{command}",
            daemon=True,
        ).start()

    def _read_output(self, process: subprocess.Popen[str], command: str) -> None:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\r\n")
            if line:
                self.messages.put(("event", parse_controller_line(line)))
        exit_code = process.wait()
        with self._lock:
            if self._process is process:
                self._process = None
        self.messages.put(("exit", {"command": command, "exit_code": exit_code}))

    def cancel(self) -> bool:
        with self._lock:
            process = self._process
        if process is None or process.poll() is not None:
            return False
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            process.terminate()
        return True


class PresentationLauncher:
    def __init__(self, root: Tk) -> None:
        self.root = root
        self.script_dir = Path(__file__).resolve().parent
        self.repo_root = self.script_dir.parents[1]
        self.deployment_profile = load_deployment_profile(self.repo_root)
        self.controller = self.script_dir / "presentationctl.py"
        self.runtime_dir = self.repo_root / ".runtime"
        self.askpass_source = self.script_dir / "presentation_askpass.cs"
        self.askpass_helper = self.runtime_dir / "presentation-askpass.exe"
        self.credential_store = WindowsCredentialStore(
            self.deployment_profile.credential_target
        )
        self.ephemeral_credential_target: str | None = None
        self.messages: queue.Queue[tuple[str, object]] = queue.Queue()
        self.runner = ControllerProcess(self.messages)
        self.current_command: str | None = None
        self.cancel_requested = False
        self.stage_states = {stage: "waiting" for stage in STAGES}
        self.live_checks: dict[str, bool] = {}

        self.tunnel_port = StringVar(value=str(self.deployment_profile.local_tunnel_port))
        self.http_port = StringVar(value=str(self.deployment_profile.host_http_port))
        self.developer_port = StringVar(value=str(self.deployment_profile.host_developer_port))
        self.open_browser = BooleanVar(value=True)
        self.ssh_password = StringVar(value="")
        self.remember_password = BooleanVar(value=False)
        self.overall_status = StringVar(value="正在讀取展示環境狀態")
        self.live_status = StringVar(value="尚未檢查")
        self.acceptance_status = StringVar(value="尚未檢查")
        self.identity_summary = StringVar(value=self._identity_summary())

        self._configure_window()
        self._configure_styles()
        self._build_interface()
        self._load_saved_credential()
        self.root.protocol("WM_DELETE_WINDOW", self._close)
        self.root.after(80, self._drain_messages)
        self.root.after(350, lambda: self._run_command("status", automatic=True))

    def _configure_window(self) -> None:
        self.root.title(
            f"BDDE38 展示環境控制台 - {self.deployment_profile.environment.upper()}"
        )
        self.root.geometry("1120x760")
        self.root.minsize(900, 620)
        self.root.configure(background="#061017")
        self.root.rowconfigure(0, weight=1)
        self.root.columnconfigure(0, weight=1)

    def _configure_styles(self) -> None:
        style = ttk.Style(self.root)
        style.theme_use("clam")
        base_font = ("Microsoft JhengHei UI", 10)
        title_font = ("Microsoft JhengHei UI", 20, "bold")
        heading_font = ("Microsoft JhengHei UI", 11, "bold")
        style.configure("TFrame", background="#061017")
        style.configure("Panel.TFrame", background="#0b1820")
        style.configure("TLabel", background="#061017", foreground="#dce9ec", font=base_font)
        style.configure("Panel.TLabel", background="#0b1820", foreground="#dce9ec", font=base_font)
        style.configure("Title.TLabel", background="#061017", foreground="#f2f8f8", font=title_font)
        style.configure("Heading.TLabel", background="#0b1820", foreground="#f2f8f8", font=heading_font)
        style.configure("Muted.TLabel", background="#061017", foreground="#8197a0", font=base_font)
        style.configure("State.TLabel", background="#0b1820", foreground="#caff4a", font=heading_font)
        style.configure("TButton", font=base_font, padding=(12, 8))
        style.configure("Accent.TButton", foreground="#061017", background="#caff4a")
        style.map("Accent.TButton", background=[("active", "#d9ff79"), ("disabled", "#526030")])
        style.configure("Danger.TButton", foreground="#f3f7f8", background="#7a2635")
        style.map("Danger.TButton", background=[("active", "#9b3345"), ("disabled", "#42232a")])
        style.configure("TCheckbutton", background="#061017", foreground="#b8c9ce", font=base_font)
        style.map("TCheckbutton", background=[("active", "#061017")])
        style.configure("TEntry", fieldbackground="#101f28", foreground="#eaf3f4")
        style.configure(
            "Treeview",
            background="#0b1820",
            fieldbackground="#0b1820",
            foreground="#cbdadd",
            rowheight=31,
            font=base_font,
        )
        style.configure(
            "Treeview.Heading",
            background="#122630",
            foreground="#dce9ec",
            font=heading_font,
        )
        style.map("Treeview", background=[("selected", "#153847")])
        style.configure(
            "Horizontal.TProgressbar",
            background="#20c7de",
            troughcolor="#11232d",
            bordercolor="#11232d",
        )

    def _build_interface(self) -> None:
        outer = ttk.Frame(self.root, padding=(22, 18))
        outer.grid(row=0, column=0, sticky="nsew")
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(4, weight=1)

        header = ttk.Frame(outer)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="BDDE38 展示環境", style="Title.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(header, textvariable=self.overall_status, style="Muted.TLabel").grid(
            row=1, column=0, sticky="w", pady=(3, 0)
        )
        ttk.Label(
            header,
            textvariable=self.identity_summary,
            style="Muted.TLabel",
        ).grid(row=2, column=0, sticky="w", pady=(3, 0))
        ttk.Label(
            header,
            text=(
                "叢集通道由本啟動器管理；啟動後請保持控制台開啟，"
                "安全停止只清理本專案的 Docker、tunnel 與暫存狀態。"
            ),
            style="Muted.TLabel",
        ).grid(row=3, column=0, sticky="w", pady=(3, 0))

        health = ttk.Frame(header, style="Panel.TFrame", padding=(14, 9))
        health.grid(row=0, column=1, rowspan=2, sticky="e")
        ttk.Label(health, text="服務", style="Panel.TLabel").grid(row=0, column=0, sticky="e")
        ttk.Label(health, textvariable=self.live_status, style="State.TLabel").grid(
            row=0, column=1, sticky="w", padx=(8, 18)
        )
        ttk.Label(health, text="五項指標", style="Panel.TLabel").grid(row=0, column=2, sticky="e")
        ttk.Label(health, textvariable=self.acceptance_status, style="State.TLabel").grid(
            row=0, column=3, sticky="w", padx=(8, 0)
        )

        actions = ttk.Frame(outer)
        actions.grid(row=1, column=0, sticky="ew", pady=(18, 10))
        actions.columnconfigure(0, weight=1)

        lifecycle_actions = ttk.Frame(actions)
        lifecycle_actions.grid(row=0, column=0, sticky="w")
        self.start_button = ttk.Button(
            lifecycle_actions,
            text="啟動",
            style="Accent.TButton",
            command=lambda: self._run_command("start"),
        )
        self.start_button.grid(row=0, column=0, padx=(0, 7))
        self.test_button = ttk.Button(
            lifecycle_actions,
            text="完整驗收",
            command=lambda: self._run_command("test"),
        )
        self.test_button.grid(row=0, column=1, padx=7)
        self.status_button = ttk.Button(
            lifecycle_actions,
            text="檢查狀態",
            command=lambda: self._run_command("status"),
        )
        self.status_button.grid(row=0, column=2, padx=7)
        self.stop_button = ttk.Button(
            lifecycle_actions,
            text="安全停止",
            style="Danger.TButton",
            command=lambda: self._run_command("stop"),
        )
        self.stop_button.grid(row=0, column=3, padx=7)
        self.cancel_button = ttk.Button(
            lifecycle_actions,
            text="取消並清理",
            command=self._cancel_current,
        )
        self.cancel_button.grid(row=0, column=4, padx=7)
        self.cancel_button.configure(state="disabled")

        navigation_actions = ttk.Frame(actions)
        navigation_actions.grid(row=0, column=1, sticky="e", padx=(20, 0))
        ttk.Button(
            navigation_actions,
            text="官網",
            command=lambda: self._open_url("official"),
        ).grid(row=0, column=0, padx=(0, 5))
        ttk.Button(
            navigation_actions,
            text="儀表板",
            command=lambda: self._open_url("dashboard"),
        ).grid(row=0, column=1, padx=5)
        ttk.Button(
            navigation_actions,
            text="開發者",
            command=lambda: self._open_url("developer"),
        ).grid(row=0, column=2, padx=5)
        ttk.Button(
            navigation_actions,
            text="記錄",
            command=self._open_runtime_dir,
        ).grid(row=0, column=3, padx=(5, 0))

        settings = ttk.Frame(outer)
        settings.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        self._add_port_input(settings, "Tunnel", self.tunnel_port, 0)
        self._add_port_input(settings, "網站", self.http_port, 2)
        self._add_port_input(settings, "開發者", self.developer_port, 4)
        ttk.Checkbutton(
            settings,
            text="啟動完成後開啟官網",
            variable=self.open_browser,
        ).grid(row=0, column=6, sticky="w", padx=(18, 0))

        ttk.Label(settings, text="SSH 密碼").grid(row=1, column=0, sticky="w", pady=(9, 0), padx=(0, 6))
        self.password_entry = ttk.Entry(settings, textvariable=self.ssh_password, show="●", width=22)
        self.password_entry.grid(row=1, column=1, columnspan=3, sticky="w", pady=(9, 0), padx=(0, 14))
        ttk.Checkbutton(
            settings,
            text="記住 SSH 密碼以支援展示期間自動重連",
            variable=self.remember_password,
        ).grid(row=1, column=4, columnspan=2, sticky="w", pady=(9, 0))
        ttk.Label(settings, text="儲存於 Windows 認證管理員", style="Muted.TLabel").grid(
            row=1, column=6, sticky="w", pady=(9, 0), padx=(18, 0)
        )

        self.progress = ttk.Progressbar(
            outer,
            mode="determinate",
            maximum=len(STAGES),
            value=0,
        )
        self.progress.grid(row=3, column=0, sticky="ew", pady=(0, 12))

        panes = ttk.Panedwindow(outer, orient="horizontal")
        panes.grid(row=4, column=0, sticky="nsew")
        stages_panel = ttk.Frame(panes, style="Panel.TFrame", padding=12)
        log_panel = ttk.Frame(panes, style="Panel.TFrame", padding=12)
        panes.add(stages_panel, weight=2)
        panes.add(log_panel, weight=5)

        stages_panel.rowconfigure(1, weight=1)
        stages_panel.columnconfigure(0, weight=1)
        ttk.Label(stages_panel, text="啟動階段", style="Heading.TLabel").grid(
            row=0, column=0, sticky="w", pady=(0, 8)
        )
        self.stage_tree = ttk.Treeview(
            stages_panel,
            columns=("stage", "state"),
            show="headings",
            selectmode="none",
        )
        self.stage_tree.heading("stage", text="階段")
        self.stage_tree.heading("state", text="狀態")
        self.stage_tree.column("stage", width=200, stretch=True)
        self.stage_tree.column("state", width=78, stretch=False, anchor="center")
        self.stage_tree.grid(row=1, column=0, sticky="nsew")
        self.stage_tree.tag_configure("waiting", foreground="#71858e")
        self.stage_tree.tag_configure("running", foreground="#20c7de")
        self.stage_tree.tag_configure("ok", foreground="#caff4a")
        self.stage_tree.tag_configure("failed", foreground="#ff7387")
        for stage in STAGES:
            self.stage_tree.insert(
                "",
                "end",
                iid=stage,
                values=(STAGE_LABELS[stage], STATUS_LABELS["waiting"]),
                tags=("waiting",),
            )

        log_panel.rowconfigure(1, weight=1)
        log_panel.columnconfigure(0, weight=1)
        ttk.Label(log_panel, text="事件紀錄", style="Heading.TLabel").grid(
            row=0, column=0, sticky="w", pady=(0, 8)
        )
        self.log = scrolledtext.ScrolledText(
            log_panel,
            wrap="word",
            state="disabled",
            background="#071219",
            foreground="#cbdadd",
            insertbackground="#f2f8f8",
            selectbackground="#1b5367",
            borderwidth=0,
            font=("Cascadia Mono", 9),
        )
        self.log.grid(row=1, column=0, sticky="nsew")

    def _add_port_input(self, parent: ttk.Frame, label: str, variable: StringVar, column: int) -> None:
        ttk.Label(parent, text=label).grid(row=0, column=column, sticky="w", padx=(0, 6))
        ttk.Spinbox(
            parent,
            from_=1,
            to=65535,
            textvariable=variable,
            width=7,
        ).grid(row=0, column=column + 1, sticky="w", padx=(0, 14))

    def _ports(self) -> PortConfig:
        try:
            ports = PortConfig(
                tunnel=int(self.tunnel_port.get()),
                http=int(self.http_port.get()),
                developer=int(self.developer_port.get()),
            )
            ports.validate()
            return ports
        except ValueError as exc:
            raise ValueError("請輸入有效且不重複的連接埠。") from exc

    def _identity_summary(self) -> str:
        profile = self.deployment_profile
        return (
            f"Profile: {profile.profile} / Cluster: {profile.environment} / "
            f"Target: {profile.ssh_target} / Route: {profile.route_label} / "
            f"Spark tunnel: 127.0.0.1:{profile.local_tunnel_port} -> {profile.remote_bridge_port} / "
            f"Web: {profile.host_http_port} / Dev: {profile.host_developer_port} / "
            f"Backend: Hive + Spark Thrift + Iceberg / "
            f"Data: {profile.serving_start} ~ {profile.serving_end}"
        )

    def _load_saved_credential(self) -> None:
        try:
            saved = self.credential_store.read()
        except OSError as exc:
            self._append_log(f"無法讀取 Windows 認證管理員：{exc}")
            return
        if saved is not None:
            _, password = saved
            self.ssh_password.set(password)
            self.remember_password.set(True)

    def _prepare_ssh_environment(self) -> dict[str, str]:
        password = self.ssh_password.get()
        remember = self.remember_password.get()
        if remember and not password:
            raise ValueError("勾選記憶密碼時，SSH 密碼不可留白。")

        if not password:
            if not remember:
                self.credential_store.delete()
            return {}

        helper = ensure_askpass_helper(self.askpass_source, self.askpass_helper)
        if remember:
            self.credential_store.write(self.deployment_profile.ssh_username, password)
            credential_target = self.deployment_profile.credential_target
        else:
            self.credential_store.delete()
            credential_target = (
                f"{self.deployment_profile.credential_target} Session {uuid.uuid4()}"
            )
            WindowsCredentialStore(credential_target).write(
                self.deployment_profile.ssh_username,
                password,
            )
            self.ephemeral_credential_target = credential_target
            self.ssh_password.set("")
        return build_askpass_environment(helper, credential_target)

    def _delete_ephemeral_credential(self) -> None:
        target = self.ephemeral_credential_target
        self.ephemeral_credential_target = None
        if target is None:
            return
        try:
            WindowsCredentialStore(target).delete()
        except OSError as exc:
            self._append_log(f"暫存 SSH 認證清理失敗：{exc}")

    def _run_command(self, command: str, *, automatic: bool = False) -> None:
        if self.runner.active:
            if not automatic:
                messagebox.showinfo("操作執行中", "請等待目前操作完成。", parent=self.root)
            return
        try:
            ports = self._ports()
        except ValueError as exc:
            if not automatic:
                messagebox.showerror("連接埠錯誤", str(exc), parent=self.root)
            return
        try:
            extra_environment = self._prepare_ssh_environment() if command == "start" else {}
        except (OSError, RuntimeError, ValueError) as exc:
            if not automatic:
                messagebox.showerror("SSH 認證錯誤", str(exc), parent=self.root)
            return
        argv = build_controller_command(
            sys.executable,
            self.controller,
            command,
            ports,
            deployment_profile=self.deployment_profile,
            open_browser=(command == "start" and self.open_browser.get()),
        )
        self.current_command = command
        self._reset_stages()
        self._set_controls_enabled(False)
        self.overall_status.set(f"正在執行：{self._command_label(command)}")
        self._append_log(f"\n> {self._command_label(command)}")
        try:
            self.runner.start(
                argv,
                cwd=self.repo_root,
                command=command,
                extra_environment=extra_environment,
            )
        except (OSError, RuntimeError) as exc:
            self._delete_ephemeral_credential()
            self._set_controls_enabled(True)
            self.current_command = None
            self.overall_status.set("無法啟動控制器")
            self._append_log(str(exc))
            if not automatic:
                messagebox.showerror("控制器錯誤", str(exc), parent=self.root)

    def _drain_messages(self) -> None:
        while True:
            try:
                kind, payload = self.messages.get_nowait()
            except queue.Empty:
                break
            if kind == "event" and isinstance(payload, dict):
                self._consume_event(payload)
            elif kind == "exit" and isinstance(payload, dict):
                self._finish_command(payload)
        self.root.after(80, self._drain_messages)

    def _consume_event(self, event: dict[str, object]) -> None:
        stage = str(event.get("stage", "preflight"))
        status = str(event.get("status", "log"))
        message = str(event.get("message", ""))
        details = event.get("details", {})
        command = str(event.get("command", self.current_command or "controller"))
        self._append_log(f"[{self._command_label(command)}] [{STAGE_LABELS.get(stage, stage)}] {message}")

        if stage in STAGES:
            display_status = status
            if status == "log" and self.stage_states.get(stage) == "waiting":
                display_status = "running"
            self._set_stage(stage, display_status)

        if stage == "docker_postgis" and status in {"ok", "failed"}:
            self.live_checks["docker_postgis"] = status == "ok"
        elif stage == "docker_app" and status in {"ok", "failed"}:
            self.live_checks["docker_app"] = status == "ok"
        elif stage == "spatial_dependencies" and status in {"ok", "failed"}:
            self.live_checks["spatial_dependencies"] = status == "ok"
        elif stage == "ssh_tunnel" and status in {"ok", "failed"}:
            self.live_checks["ssh_tunnel"] = status == "ok"
        elif stage == "application_health" and status in {"ok", "failed"}:
            component = "application_health"
            if isinstance(details, dict):
                component = str(details.get("component", component))
            self.live_checks[component] = status == "ok"
        elif stage == "smoke_test" and status in {"ok", "failed"}:
            self.acceptance_status.set("已通過" if status == "ok" else "未通過")
        elif stage == "ready" and status == "ok":
            self.live_status.set("可用")
            self.acceptance_status.set("已通過")
        self._refresh_live_status()

    def _finish_command(self, payload: dict[str, object]) -> None:
        command = str(payload.get("command", self.current_command or "controller"))
        exit_code = int(payload.get("exit_code", 1))
        if command == "stop" or (command == "start" and exit_code != 0):
            self._delete_ephemeral_credential()
        if self.cancel_requested:
            self.cancel_requested = False
            self.current_command = None
            self._set_controls_enabled(True)
            self.overall_status.set("正在清理本次啟動資源")
            self._append_log("控制器已取消；改由既有停止契約清理本專案資源。")
            self.root.after(100, lambda: self._run_command("stop", automatic=True))
            return
        self.current_command = None
        self._set_controls_enabled(True)
        message = EXIT_MESSAGES.get(exit_code, f"操作失敗（Exit Code {exit_code}）")
        if exit_code == 0:
            self.overall_status.set(f"{self._command_label(command)}：{message}")
            if command == "stop":
                self.live_status.set("已停止")
                self.acceptance_status.set("未啟動")
        elif command == "status" and exit_code == 1:
            self.overall_status.set("展示環境尚未完全就緒")
        else:
            self.overall_status.set(message)
        self._append_log(f"{self._command_label(command)}結束：{message}（{exit_code}）")

    def _reset_stages(self) -> None:
        self.stage_states = {stage: "waiting" for stage in STAGES}
        self.live_checks.clear()
        for stage in STAGES:
            self._set_stage(stage, "waiting")
        self.progress.configure(value=0)

    def _set_stage(self, stage: str, status: str) -> None:
        if status not in STATUS_LABELS:
            status = "info"
        visual_status = "running" if status in {"info", "log"} else status
        self.stage_states[stage] = visual_status
        self.stage_tree.item(
            stage,
            values=(STAGE_LABELS[stage], STATUS_LABELS[status]),
            tags=(visual_status,),
        )
        completed = sum(value == "ok" for value in self.stage_states.values())
        active = 1 if any(value == "running" for value in self.stage_states.values()) else 0
        self.progress.configure(value=min(len(STAGES), completed + active * 0.45))
        self.stage_tree.see(stage)

    def _refresh_live_status(self) -> None:
        required = {
            "docker_postgis",
            "docker_app",
            "spatial_dependencies",
            "ssh_tunnel",
            "official_site",
            "dashboard",
            "health",
            "developer",
        }
        if any(value is False for value in self.live_checks.values()):
            self.live_status.set("未就緒")
        elif required.issubset(self.live_checks) and all(self.live_checks[key] for key in required):
            self.live_status.set("可用")
        elif self.live_checks:
            self.live_status.set("檢查中")

    def _set_controls_enabled(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        for button in (self.start_button, self.test_button, self.status_button, self.stop_button):
            button.configure(state=state)
        self.cancel_button.configure(state="disabled" if enabled else "normal")

    def _cancel_current(self) -> None:
        if not self.runner.active:
            return
        if not messagebox.askyesno(
            "取消操作",
            "取消目前操作，並以安全停止契約清理本專案建立的資源？",
            parent=self.root,
        ):
            return
        self.cancel_requested = True
        self.cancel_button.configure(state="disabled")
        self.overall_status.set("正在取消操作")
        self._append_log("正在取消控制器程序；完成後將執行安全停止。")
        if not self.runner.cancel():
            self.cancel_requested = False
            self._set_controls_enabled(True)

    def _append_log(self, text: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _open_url(self, target: str) -> None:
        try:
            ports = self._ports()
        except ValueError as exc:
            messagebox.showerror("連接埠錯誤", str(exc), parent=self.root)
            return
        urls = {
            "official": f"http://127.0.0.1:{ports.http}/",
            "dashboard": f"http://127.0.0.1:{ports.http}/dashboard/",
            "developer": f"http://127.0.0.1:{ports.developer}/",
        }
        webbrowser.open(urls[target])

    def _open_runtime_dir(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            os.startfile(self.runtime_dir)  # type: ignore[attr-defined]
        else:
            webbrowser.open(self.runtime_dir.as_uri())

    def _close(self) -> None:
        if self.runner.active:
            messagebox.showinfo(
                "操作執行中",
                "請等待目前操作完成，再關閉控制台。",
                parent=self.root,
            )
            return
        self._delete_ephemeral_credential()
        self.root.destroy()

    @staticmethod
    def _command_label(command: str) -> str:
        return {
            "start": "啟動",
            "stop": "停止",
            "status": "狀態檢查",
            "test": "完整驗收",
            "controller": "控制器",
        }.get(command, command)


def main() -> int:
    root = Tk()
    PresentationLauncher(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
