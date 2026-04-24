"""Streamlit dashboard — MSP Launchpad SEO Indexing Monitor.

Multi-client control panel: list view of clients + per-client detail view
(Overview, Run, History). Data is isolated per client (separate SQLite DB,
separate CSV folder) so runs never mix.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
import streamlit as st

import manual_submit
import run_state
from run_state import RunStatus

# ---------------------------------------------------------------------------
# Paths + constants
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(__file__).parent
CLIENTS_FILE = PROJECT_DIR / "clients.json"
DATA_DIR = PROJECT_DIR / "data"
REPORTS_DIR = PROJECT_DIR / "reports"
LOGO_PATH = PROJECT_DIR / "assets" / "msp-launchpad-logo.png"
CREDENTIALS_PATH = PROJECT_DIR / "service-account.json"

INDEXED_TRUE = {"true", "yes", "1"}
SLUG_RE = re.compile(r"[^a-z0-9]+")

# MSP Launchpad brand — single warm-orange accent, mirrored light/dark neutrals.
# Tokens mirror src/styles/prototype-tokens.css in the DFY portal codebase.
BRAND_ORANGE = "#FF782D"          # brand-500
BRAND_ORANGE_400 = "#FF8F4F"
BRAND_ORANGE_300 = "#FFA572"
BRAND_ORANGE_600 = "#E86A1F"
CTA_GRADIENT = f"linear-gradient(135deg, {BRAND_ORANGE_400} 0%, {BRAND_ORANGE_300} 100%)"

LIGHT_THEME = {
    "bg":            "#F6F6F4",
    "bg_gradient":   "linear-gradient(180deg, #FFFFFF 0%, #FAFAF8 100%)",
    "surface":       "#FFFFFF",
    "surface_alt":   "#F0F0EC",
    "surface_hover": "#F0F0EC",
    "border":        "rgba(13,13,16,0.06)",
    "border_strong": "rgba(255,120,45,0.40)",
    "text":          "#0D0D10",
    "text_soft":     "#4A4A56",
    "text_muted":    "#7A7A88",
    "accent":        BRAND_ORANGE,
    "accent_hover": BRAND_ORANGE_600,
    "accent_soft":  "rgba(255,143,79,0.08)",
    "accent_border":"rgba(255,143,79,0.24)",
    "accent_text":  "#E86A1F",
    "success":      "#A3E635",
    "success_soft": "rgba(163,230,53,0.12)",
    "warning":      "#FBBF24",
    "danger":       "#FB7185",
    "shadow":       "0 2px 8px rgba(13,13,16,0.06)",
    "shadow_hover": "0 8px 24px rgba(13,13,16,0.08)",
    "code_bg":      "#FAFAF8",
    "input_bg":     "#FFFFFF",
}

DARK_THEME = {
    "bg":            "#0D0D10",
    # "Glow from the top" — two soft radial gradients in brand-orange at 4–8%.
    "bg_gradient":   (
        "radial-gradient(ellipse 80% 50% at 20% 10%, rgba(255,143,79,0.08), transparent), "
        "radial-gradient(ellipse 60% 40% at 80% 40%, rgba(255,143,79,0.04), transparent), "
        "#0D0D10"
    ),
    "surface":       "#15151B",
    "surface_alt":   "#15151B",
    "surface_hover": "#1C1C24",
    "border":        "rgba(255,255,255,0.06)",
    "border_strong": "rgba(255,143,79,0.30)",
    "text":          "#F5F5F7",
    "text_soft":     "#B8B8C4",
    "text_muted":    "#7A7A88",
    "accent":        BRAND_ORANGE_400,
    "accent_hover": BRAND_ORANGE_300,
    "accent_soft":  "rgba(255,143,79,0.08)",
    "accent_border":"rgba(255,143,79,0.24)",
    "accent_text":  BRAND_ORANGE_400,
    "success":      "#A3E635",
    "success_soft": "rgba(163,230,53,0.12)",
    "warning":      "#FBBF24",
    "danger":       "#FB7185",
    "shadow":       "0 4px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04)",
    "shadow_hover": "0 10px 25px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
    "code_bg":      "#0D0D10",
    "input_bg":     "#0D0D10",
}


# ---------------------------------------------------------------------------
# Client data model + persistence
# ---------------------------------------------------------------------------
@dataclass
class Client:
    id: str
    name: str
    domain: str
    sitemap_url: str
    gsc_site_url: str
    created_at: str

    @property
    def db_path(self) -> Path:
        return DATA_DIR / f"{self.id}.db"

    @property
    def reports_dir(self) -> Path:
        return REPORTS_DIR / self.id


def load_clients() -> list[Client]:
    if not CLIENTS_FILE.exists():
        return []
    data = json.loads(CLIENTS_FILE.read_text(encoding="utf-8"))
    return [Client(**c) for c in data.get("clients", [])]


def save_clients(clients: list[Client]) -> None:
    CLIENTS_FILE.write_text(
        json.dumps({"clients": [asdict(c) for c in clients]}, indent=2),
        encoding="utf-8",
    )


def slugify(name: str) -> str:
    slug = SLUG_RE.sub("-", name.lower()).strip("-")
    return slug or "client"


def get_client_csvs(client: Client) -> list[Path]:
    if not client.reports_dir.exists():
        return []
    return sorted(client.reports_dir.glob("*.csv"), reverse=True)


def last_run_date(client: Client) -> str | None:
    csvs = get_client_csvs(client)
    if not csvs:
        return None
    return datetime.fromtimestamp(csvs[0].stat().st_mtime).strftime("%Y-%m-%d")


def client_stats(client: Client) -> dict | None:
    csvs = get_client_csvs(client)
    if not csvs:
        return None
    try:
        df = pd.read_csv(csvs[0])
    except Exception:
        return None
    return summarize_report(df)


def summarize_report(df: pd.DataFrame) -> dict[str, int]:
    total = len(df)
    indexed_mask = df["indexed"].astype(str).str.lower().isin(INDEXED_TRUE)
    submitted_mask = df["submitted"].astype(str).str.lower().isin(INDEXED_TRUE)
    return {
        "total": total,
        "indexed": int(indexed_mask.sum()),
        "not_indexed": int((~indexed_mask).sum()),
        "submitted": int(submitted_mask.sum()),
    }


# ---------------------------------------------------------------------------
# Streamlit page config + global styling
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="Indexing Monitor · MSP Launchpad",
    page_icon=str(LOGO_PATH) if LOGO_PATH.exists() else ":mag:",
    layout="wide",
    initial_sidebar_state="expanded",
)


# ---------------------------------------------------------------------------
# Session state (must come before CSS injection — CSS reads theme_mode)
# ---------------------------------------------------------------------------
if "view" not in st.session_state:
    st.session_state.view = "list"
if "selected_client_id" not in st.session_state:
    st.session_state.selected_client_id = None
if "auto_run" not in st.session_state:
    st.session_state.auto_run = False
if "search_query" not in st.session_state:
    st.session_state.search_query = ""
if "theme_mode" not in st.session_state:
    st.session_state.theme_mode = "dark"
# --- Submit URLs view state ---
# `submit_routed` holds the RoutedUrl list after Analyze so it persists
# across reruns without recomputing. `submit_overrides` maps URL→client_id
# for rows the user has manually assigned (unknown-domain recovery).
# `submit_results` is populated after Submit and holds per-URL outcomes.
if "submit_input" not in st.session_state:
    st.session_state.submit_input = ""
if "submit_routed" not in st.session_state:
    st.session_state.submit_routed = None
if "submit_overrides" not in st.session_state:
    st.session_state.submit_overrides = {}
if "submit_results" not in st.session_state:
    st.session_state.submit_results = None


def resolve_credentials() -> str:
    """Mirror the credentials lookup used by the sitemap runner:
    service-account.json → GOOGLE_CREDENTIALS env var → st.secrets."""
    if CREDENTIALS_PATH.exists():
        return str(CREDENTIALS_PATH)
    env_val = os.environ.get("GOOGLE_CREDENTIALS", "").strip()
    if env_val:
        return env_val
    try:
        return st.secrets.get("GOOGLE_CREDENTIALS", "")
    except Exception:
        return ""


def get_theme() -> dict:
    return DARK_THEME if st.session_state.theme_mode == "dark" else LIGHT_THEME


# ---------------------------------------------------------------------------
# Themed stylesheet. Uses CSS custom properties so switching between light
# and dark only re-renders this one block; every other component reads the
# variables and picks up the new palette automatically.
# ---------------------------------------------------------------------------
def inject_theme_css() -> None:
    t = get_theme()
    is_dark = st.session_state.theme_mode == "dark"
    # Sidebar follows theme: dark surface on dark, elevated white on light.
    if is_dark:
        sidebar_bg = "#15151B"
        sidebar_border = "rgba(255,255,255,0.06)"
        sidebar_text = "#F5F5F7"
        sidebar_text_soft = "#B8B8C4"
        sidebar_text_muted = "#7A7A88"
        sidebar_btn_border = "rgba(255,255,255,0.10)"
        sidebar_btn_hover_bg = "rgba(255,255,255,0.04)"
        sidebar_logo_filter = "invert(1)"
    else:
        sidebar_bg = "#FFFFFF"
        sidebar_border = "rgba(13,13,16,0.06)"
        sidebar_text = "#0D0D10"
        sidebar_text_soft = "#4A4A56"
        sidebar_text_muted = "#7A7A88"
        sidebar_btn_border = "rgba(13,13,16,0.10)"
        sidebar_btn_hover_bg = "rgba(13,13,16,0.04)"
        sidebar_logo_filter = "none"
    scrollbar_thumb = "rgba(255,255,255,0.08)" if is_dark else "rgba(13,13,16,0.12)"
    scrollbar_track = "transparent"

    st.markdown(
        f"""
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Lexend:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

        :root {{
            --bg:            {t['bg']};
            --bg-gradient:   {t['bg_gradient']};
            --surface:       {t['surface']};
            --surface-alt:   {t['surface_alt']};
            --surface-hover: {t['surface_hover']};
            --border:        {t['border']};
            --border-strong: {t['border_strong']};
            --text:          {t['text']};
            --text-soft:     {t['text_soft']};
            --text-muted:    {t['text_muted']};
            --accent:        {t['accent']};
            --accent-hover:  {t['accent_hover']};
            --accent-soft:   {t['accent_soft']};
            --accent-border: {t['accent_border']};
            --accent-text:   {t['accent_text']};
            --success:       {t['success']};
            --success-soft:  {t['success_soft']};
            --warning:       {t['warning']};
            --danger:        {t['danger']};
            --shadow:        {t['shadow']};
            --shadow-hover:  {t['shadow_hover']};
            --shadow-cta:    0 1px 10px rgba(255,143,79,0.40), 0 0 30px rgba(255,143,79,0.15);
            --shadow-cta-hover: 0 2px 14px rgba(255,143,79,0.50), 0 0 40px rgba(255,143,79,0.25);
            --code-bg:       {t['code_bg']};
            --input-bg:      {t['input_bg']};
            --cta-gradient:  {CTA_GRADIENT};
            --font-display:  "Lexend", system-ui, -apple-system, "Segoe UI", sans-serif;
            --font-ui:       "Figtree", system-ui, -apple-system, "Segoe UI", sans-serif;
            --font-mono:     "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
            --ease-out:      cubic-bezier(0.22, 1, 0.36, 1);
        }}

        /* Base surface */
        html, body, .stApp {{ font-family: var(--font-ui) !important; }}
        .stApp {{ background: var(--bg-gradient) !important; color: var(--text); }}
        .main .block-container {{ padding-top: 2.25rem; padding-bottom: 4rem; max-width: 1120px; }}
        header[data-testid="stHeader"] {{ background: transparent; }}
        #MainMenu, footer {{ visibility: hidden; }}

        /* Typography — Lexend for display/headings, Figtree for body */
        body, .stApp, p, span, label, div {{ color: var(--text); font-family: var(--font-ui); }}
        h1, h2, h3, h4, h5, h6 {{
            color: var(--text) !important;
            font-family: var(--font-display) !important;
            font-weight: 600;
            letter-spacing: -0.015em;
        }}
        h1 {{ font-size: 30px; line-height: 38px; letter-spacing: -0.02em; }}
        h2 {{ font-size: 22px; line-height: 30px; }}
        h3 {{ font-size: 18px; line-height: 26px; }}
        h4 {{ font-size: 16px; line-height: 24px; }}
        .stCaption, [data-testid="stCaptionContainer"] {{ color: var(--text-muted) !important; font-size: 12px; }}

        /* Buttons — ghost by default, gradient CTA glow on primary */
        .stButton > button {{
            border-radius: 12px;
            font-family: var(--font-ui);
            font-size: 13px;
            font-weight: 500;
            background: transparent;
            color: var(--text-soft);
            border: 1px solid var(--border);
            padding: 10px 20px;
            transition: all 0.15s var(--ease-out);
        }}
        .stButton > button:hover:not(:disabled) {{
            border-color: var(--border-strong);
            color: var(--text);
            background: var(--accent-soft);
        }}
        .stButton > button:disabled {{
            background: var(--bg);
            color: var(--text-muted);
            border: 1px solid var(--border);
            cursor: not-allowed;
            box-shadow: none;
            opacity: 1;
        }}
        .stButton > button[kind="primary"] {{
            background: var(--cta-gradient);
            border: none;
            color: #0D0D10;
            font-weight: 600;
            box-shadow: var(--shadow-cta);
        }}
        .stButton > button[kind="primary"]:hover:not(:disabled) {{
            transform: translateY(-1px);
            box-shadow: var(--shadow-cta-hover);
            color: #0D0D10;
        }}
        .stButton > button[kind="primary"]:focus-visible {{
            outline: 2px solid var(--accent);
            outline-offset: 2px;
        }}
        .stButton > button[kind="primary"]:disabled {{
            background: var(--bg);
            color: var(--text-muted);
            box-shadow: none;
            border: 1px solid var(--border);
        }}

        /* Metric cards */
        [data-testid="stMetric"] {{
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 20px 22px;
            border-radius: 16px;
            box-shadow: var(--shadow);
        }}
        [data-testid="stMetricValue"] {{
            color: var(--text) !important;
            font-family: var(--font-display);
            font-weight: 600;
            font-size: 2rem !important;
            letter-spacing: -0.01em;
        }}
        [data-testid="stMetricLabel"] {{
            color: var(--text-muted) !important;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            font-size: 0.72rem !important;
        }}
        [data-testid="stMetricDelta"] {{ color: var(--text-muted) !important; }}

        /* Sidebar — follows theme */
        [data-testid="stSidebar"] {{
            background: {sidebar_bg} !important;
            border-right: 1px solid {sidebar_border};
        }}
        [data-testid="stSidebar"] * {{ color: {sidebar_text_soft}; }}
        [data-testid="stSidebar"] .block-container {{ padding-top: 1.5rem; }}
        [data-testid="stSidebar"] h1,
        [data-testid="stSidebar"] h2,
        [data-testid="stSidebar"] h3,
        [data-testid="stSidebar"] h4 {{
            color: {sidebar_text} !important;
            font-family: var(--font-display) !important;
        }}
        [data-testid="stSidebar"] p,
        [data-testid="stSidebar"] label {{ color: {sidebar_text_soft} !important; }}
        [data-testid="stSidebar"] .stCaption,
        [data-testid="stSidebar"] [data-testid="stCaptionContainer"] {{ color: {sidebar_text_muted} !important; }}
        [data-testid="stSidebar"] .stButton > button {{
            background: transparent;
            border: 1px solid {sidebar_btn_border};
            color: {sidebar_text_soft};
        }}
        [data-testid="stSidebar"] .stButton > button:hover:not(:disabled) {{
            background: {sidebar_btn_hover_bg};
            border-color: rgba(255,143,79,0.30);
            color: {sidebar_text};
        }}
        [data-testid="stSidebar"] .stButton > button:disabled {{
            background: rgba(255,143,79,0.08);
            color: {sidebar_text};
            border: 1px solid rgba(255,143,79,0.30);
            box-shadow: inset 0 0 0 1px rgba(255,143,79,0.30);
        }}
        [data-testid="stSidebar"] hr {{ border-color: {sidebar_border} !important; }}
        [data-testid="stSidebar"] [data-testid="stRadio"] label {{ color: {sidebar_text_soft} !important; }}

        /* Inputs */
        [data-testid="stTextInput"] input,
        [data-testid="stTextArea"] textarea,
        input[type="text"] {{
            background: var(--input-bg) !important;
            color: var(--text) !important;
            border-radius: 8px !important;
            border: 1px solid var(--border) !important;
            font-family: var(--font-ui) !important;
            font-size: 13.5px !important;
            box-shadow: inset 0 1px 2px rgba(0,0,0,{0.3 if is_dark else 0.04}) !important;
        }}
        [data-testid="stTextInput"] input::placeholder {{ color: var(--text-muted); opacity: 0.7; }}
        [data-testid="stTextInput"] input:focus,
        [data-testid="stTextArea"] textarea:focus {{
            border-color: var(--accent) !important;
            box-shadow: 0 0 0 3px rgba(255,143,79,0.15) !important;
            outline: none !important;
        }}

        /* Form */
        [data-testid="stForm"] {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 8px;
            box-shadow: var(--shadow);
        }}

        /* Tabs */
        .stTabs [data-baseweb="tab-list"] {{
            border-bottom: 1px solid var(--border);
            gap: 2rem;
        }}
        .stTabs [data-baseweb="tab"] {{
            color: var(--text-muted);
            font-family: var(--font-ui);
            font-weight: 600;
            font-size: 13.5px;
            padding: 10px 2px;
        }}
        .stTabs [data-baseweb="tab-list"] button[aria-selected="true"] {{
            color: var(--accent) !important;
        }}
        .stTabs [data-baseweb="tab-highlight"] {{
            background: var(--accent) !important;
            height: 3px;
            border-radius: 2px;
        }}

        /* Streamlit built-in progress bar — orange gradient with soft highlight */
        .stProgress > div > div {{ background: rgba(255,143,79,0.15); border-radius: 999px; }}
        .stProgress > div > div > div {{
            background:
                radial-gradient(ellipse at 50% 50%, rgba(255,200,140,0.5) 0%, transparent 65%),
                var(--cta-gradient) !important;
            border-radius: 999px;
            box-shadow: 0 0 10px rgba(255,143,79,0.35);
        }}

        /* Dividers */
        hr {{ border-color: var(--border) !important; opacity: 1 !important; }}

        /* DataFrames */
        [data-testid="stDataFrame"] {{
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            background: var(--surface);
        }}

        /* Code blocks — JetBrains Mono */
        pre, code, [data-testid="stCodeBlock"] {{
            background: var(--code-bg) !important;
            color: var(--text-soft) !important;
            border-radius: 12px !important;
            border: 1px solid var(--border);
            font-family: var(--font-mono) !important;
            font-size: 12.5px !important;
        }}

        /* Alerts */
        [data-testid="stAlert"] {{
            border-radius: 16px !important;
            border: 1px solid var(--border);
            background: var(--surface);
            box-shadow: var(--shadow);
        }}

        /* Expanders */
        [data-testid="stExpander"] {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            box-shadow: var(--shadow);
        }}
        [data-testid="stExpander"] summary {{
            color: var(--text) !important;
            font-family: var(--font-ui);
            font-weight: 600;
        }}

        /* Download button — same shape/feel as ghost button */
        .stDownloadButton > button {{
            border-radius: 12px;
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-soft);
            font-family: var(--font-ui);
            font-weight: 500;
        }}
        .stDownloadButton > button:hover {{
            border-color: var(--border-strong);
            color: var(--text);
            background: var(--accent-soft);
        }}

        /* Radio (sidebar theme switcher) */
        [data-testid="stRadio"] > div {{ gap: 6px; }}

        /* -----------------------------------------------------------------
           Custom components
           ----------------------------------------------------------------- */

        /* Page header strip */
        .page-header {{
            display: flex; flex-direction: column; gap: 6px;
            margin-bottom: 24px;
        }}
        .page-header .eyebrow {{
            color: var(--accent-text);
            font-family: var(--font-ui);
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            line-height: 16px;
        }}
        .page-header h1 {{
            font-family: var(--font-display) !important;
            font-size: 30px;
            line-height: 38px;
            margin: 0;
            font-weight: 600;
            color: var(--text);
            letter-spacing: -0.02em;
        }}
        .page-header .sub {{
            color: var(--text-soft);
            font-size: 14px;
            line-height: 22px;
            margin-top: 2px;
        }}

        /* Dashboard stats strip */
        .stats-strip {{
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 28px;
        }}
        .stats-tile {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px 22px;
            box-shadow: var(--shadow);
            transition: transform 0.15s var(--ease-out),
                        box-shadow 0.15s var(--ease-out),
                        border-color 0.15s var(--ease-out);
        }}
        .stats-tile:hover {{
            transform: translateY(-1px);
            box-shadow: var(--shadow-hover);
            border-color: var(--border-strong);
        }}
        .stats-tile .label {{
            color: var(--text-muted);
            font-family: var(--font-mono);
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }}
        .stats-tile .value {{
            color: var(--text);
            font-family: var(--font-display);
            font-size: 32px;
            line-height: 40px;
            font-weight: 600;
            margin-top: 6px;
            letter-spacing: -0.02em;
        }}
        .stats-tile .sub {{
            color: var(--text-muted);
            font-size: 12px;
            margin-top: 2px;
        }}
        .stats-tile.accent {{
            background: linear-gradient(180deg, rgba(255,143,79,0.10) 0%, var(--surface) 60%);
            border-color: var(--accent-border);
        }}
        .stats-tile.accent .value {{ color: var(--accent); }}

        /* Client card — MSP act-card style */
        .client-card {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px 22px;
            margin-bottom: 4px;
            box-shadow: var(--shadow);
            transition: border-color 0.15s var(--ease-out),
                        box-shadow 0.15s var(--ease-out),
                        transform 0.15s var(--ease-out);
            position: relative;
        }}
        .client-card:hover {{
            border-color: var(--border-strong);
            box-shadow: var(--shadow-hover);
            transform: translateY(-1px);
        }}
        .client-card h4 {{
            font-family: var(--font-display) !important;
            margin: 0 0 4px 0;
            font-size: 18px;
            line-height: 24px;
            font-weight: 600;
            letter-spacing: -0.01em;
            color: var(--text) !important;
            display: flex;
            align-items: center;
        }}
        .client-card .domain {{
            color: var(--text-muted);
            font-size: 13px;
            margin-bottom: 16px;
        }}
        .client-card .status-row {{
            display: flex; gap: 24px;
            font-size: 13px;
            color: var(--text-soft);
        }}
        .client-card .status-row strong {{
            color: var(--text);
            font-weight: 600;
            font-size: 14px;
        }}
        .client-card .last-run {{
            color: var(--text-muted);
            font-family: var(--font-mono);
            font-size: 11px;
            letter-spacing: 0.02em;
            margin-top: 14px;
        }}

        /* Status dots */
        .status-dot {{
            display: inline-block;
            width: 8px; height: 8px;
            border-radius: 50%;
            margin-right: 10px;
            vertical-align: middle;
        }}
        .status-dot.green {{ background: var(--success); box-shadow: 0 0 0 2px rgba(163,230,53,0.18); }}
        .status-dot.amber {{ background: var(--accent); box-shadow: 0 0 0 2px rgba(255,143,79,0.18); }}
        .status-dot.gray  {{ background: var(--text-muted); opacity: 0.5; }}

        /* Live pulsing dot */
        .live-dot {{
            display: inline-block;
            width: 8px; height: 8px;
            border-radius: 50%;
            background: var(--accent);
            margin-right: 10px;
            vertical-align: middle;
            box-shadow: 0 0 0 2px rgba(255,143,79,0.18), 0 0 8px rgba(255,143,79,0.45);
            animation: livePulse 1.6s ease-in-out infinite;
        }}
        @keyframes livePulse {{
            0%,100% {{ box-shadow: 0 0 0 2px rgba(255,143,79,0.18), 0 0 8px rgba(255,143,79,0.45); transform: scale(1); }}
            50%      {{ box-shadow: 0 0 0 6px rgba(255,143,79,0), 0 0 14px rgba(255,143,79,0.60); transform: scale(1.12); }}
        }}

        /* Run-progress block on list-view cards */
        .run-progress {{
            margin-top: 14px;
            padding: 12px 14px;
            background: var(--accent-soft);
            border: 1px solid var(--accent-border);
            border-radius: 12px;
        }}
        .run-progress-label {{
            font-family: var(--font-mono);
            font-size: 11px;
            color: var(--accent-text);
            font-weight: 600;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }}
        .run-progress-bar-bg {{
            background: rgba(255,143,79,0.15);
            height: 6px;
            border-radius: 999px;
            overflow: hidden;
        }}
        .run-progress-bar {{
            background:
                radial-gradient(ellipse at 50% 50%, rgba(255,200,140,0.5) 0%, transparent 65%),
                var(--cta-gradient);
            height: 100%;
            border-radius: 999px;
            transition: width 0.4s var(--ease-out);
            box-shadow: 0 0 8px rgba(255,143,79,0.45);
        }}

        /* Run banner on detail view */
        .run-banner {{
            background: var(--accent-soft);
            border: 1px solid var(--accent-border);
            border-left: 4px solid var(--accent);
            padding: 16px 20px;
            border-radius: 16px;
            margin-bottom: 18px;
        }}
        .run-banner-title {{
            font-family: var(--font-display);
            color: var(--text);
            font-weight: 600;
            font-size: 16px;
            line-height: 24px;
            display: flex; align-items: center;
        }}
        .run-banner-sub {{
            color: var(--text-muted);
            font-size: 13px;
            margin-top: 4px;
        }}

        /* Sidebar logo — logo ships black; invert it only on dark sidebar. */
        [data-testid="stSidebar"] [data-testid="stImage"] img {{
            filter: {sidebar_logo_filter};
            opacity: 0.98;
        }}

        /* Footer */
        .mspl-footer {{
            text-align: center;
            color: var(--text-muted);
            font-size: 12px;
            padding: 2.25rem 0 0.5rem 0;
            border-top: 1px solid var(--border);
            margin-top: 3.5rem;
            letter-spacing: 0.02em;
        }}
        .mspl-footer strong {{
            color: var(--text);
            font-family: var(--font-display);
            font-weight: 700;
            letter-spacing: 0.04em;
        }}

        /* Scrollbar */
        ::-webkit-scrollbar {{ width: 8px; height: 8px; }}
        ::-webkit-scrollbar-track {{ background: {scrollbar_track}; }}
        ::-webkit-scrollbar-thumb {{
            background: {scrollbar_thumb};
            border-radius: 999px;
        }}
        ::-webkit-scrollbar-thumb:hover {{ background: var(--accent); }}
        </style>
        """,
        unsafe_allow_html=True,
    )


inject_theme_css()


def go_to_list() -> None:
    st.session_state.view = "list"
    st.session_state.selected_client_id = None
    st.session_state.auto_run = False


def go_to_detail(client_id: str) -> None:
    st.session_state.view = "detail"
    st.session_state.selected_client_id = client_id
    st.session_state.auto_run = False


def go_to_detail_and_run(client_id: str) -> None:
    st.session_state.view = "detail"
    st.session_state.selected_client_id = client_id
    st.session_state.auto_run = True


def go_to_add() -> None:
    st.session_state.view = "add"


def go_to_submit() -> None:
    st.session_state.view = "submit"


# ---------------------------------------------------------------------------
# Sidebar — brand + nav
# ---------------------------------------------------------------------------
with st.sidebar:
    if LOGO_PATH.exists():
        st.image(str(LOGO_PATH), width=170)

    st.markdown("### Indexing Monitor")
    st.caption("Internal SEO tool · v1.0")

    st.divider()

    st.button(
        "All clients",
        use_container_width=True,
        on_click=go_to_list,
        disabled=st.session_state.view == "list",
    )
    st.button(
        "Submit URLs",
        use_container_width=True,
        on_click=go_to_submit,
        disabled=st.session_state.view == "submit",
        help="Paste newly published URLs from any client and submit them for indexing.",
    )
    st.button(
        "Add client",
        use_container_width=True,
        on_click=go_to_add,
        disabled=st.session_state.view == "add",
    )

    st.divider()
    st.caption(
        "Each client has its own sitemap, Search Console property, "
        "database, and run history."
    )

    # Theme switcher — bottom of sidebar, visible on every view.
    st.divider()
    st.markdown("#### Appearance")
    theme_choice = st.radio(
        "Theme",
        options=["Dark", "Light"],
        index=0 if st.session_state.theme_mode == "dark" else 1,
        horizontal=True,
        label_visibility="collapsed",
        key="theme_choice_radio",
    )
    new_mode = "dark" if theme_choice == "Dark" else "light"
    if new_mode != st.session_state.theme_mode:
        st.session_state.theme_mode = new_mode
        st.rerun()


# ---------------------------------------------------------------------------
# Header helper
# ---------------------------------------------------------------------------
def render_header(
    title: str, subtitle: str | None = None, eyebrow: str | None = None
) -> None:
    eyebrow_html = f"<div class='eyebrow'>{eyebrow}</div>" if eyebrow else ""
    sub_html = f"<div class='sub'>{subtitle}</div>" if subtitle else ""
    st.markdown(
        f"<div class='page-header'>{eyebrow_html}<h1>{title}</h1>{sub_html}</div>",
        unsafe_allow_html=True,
    )


# ---------------------------------------------------------------------------
# Reusable rendering
# ---------------------------------------------------------------------------
def render_summary_metrics(stats: dict[str, int]) -> None:
    c1, c2, c3, c4 = st.columns(4)
    total = stats["total"] or 1
    c1.metric("Total URLs", stats["total"])
    c2.metric(
        "Indexed",
        stats["indexed"],
        f"{stats['indexed'] * 100 / total:.0f}% of sitemap",
    )
    c3.metric("Not indexed", stats["not_indexed"])
    c4.metric("Submitted last run", stats["submitted"])


# ---------------------------------------------------------------------------
# LIST VIEW
# ---------------------------------------------------------------------------
def render_dashboard_stats(clients: list[Client]) -> None:
    """Four-tile summary strip at the top of the list view: total clients,
    URLs tracked across all sitemaps, indexed total, and active runs."""
    total_urls = 0
    total_indexed = 0
    clients_with_data = 0
    for c in clients:
        stats = client_stats(c)
        if stats is None:
            continue
        clients_with_data += 1
        total_urls += stats["total"]
        total_indexed += stats["indexed"]

    active_runs = sum(1 for c in clients if run_state.is_running(c.id))
    indexed_pct = (total_indexed / total_urls * 100) if total_urls else 0
    coverage_sub = (
        f"{total_indexed:,} of {total_urls:,} · {indexed_pct:.0f}%"
        if total_urls else "No runs yet"
    )
    runs_sub = "Live now" if active_runs else "Idle"

    st.markdown(
        "<div class='stats-strip'>"
        "<div class='stats-tile'>"
        "<div class='label'>Total clients</div>"
        f"<div class='value'>{len(clients)}</div>"
        f"<div class='sub'>{clients_with_data} with run data</div>"
        "</div>"
        "<div class='stats-tile'>"
        "<div class='label'>URLs tracked</div>"
        f"<div class='value'>{total_urls:,}</div>"
        "<div class='sub'>Across all sitemaps</div>"
        "</div>"
        "<div class='stats-tile'>"
        "<div class='label'>Indexed</div>"
        f"<div class='value'>{total_indexed:,}</div>"
        f"<div class='sub'>{coverage_sub}</div>"
        "</div>"
        f"<div class='stats-tile{' accent' if active_runs else ''}'>"
        "<div class='label'>Active runs</div>"
        f"<div class='value'>{active_runs}</div>"
        f"<div class='sub'>{runs_sub}</div>"
        "</div>"
        "</div>",
        unsafe_allow_html=True,
    )


def render_list_view() -> None:
    render_header(
        "Website Page Indexing",
        "Track every client site's Google indexing status, run a fresh check, or review past reports.",
        eyebrow="DASHBOARD",
    )

    clients = load_clients()
    render_dashboard_stats(clients)

    top_1, top_2, top_3 = st.columns([3, 2, 1])
    top_1.markdown(f"**{len(clients)} client{'s' if len(clients) != 1 else ''}**")

    with top_2:
        query = st.text_input(
            "Search clients",
            value=st.session_state.search_query,
            placeholder="Search by name or domain…",
            label_visibility="collapsed",
            key="search_input",
        ) or ""
    st.session_state.search_query = query

    top_3.button(
        "+ Add new client",
        use_container_width=True,
        on_click=go_to_add,
        type="primary",
    )

    st.divider()

    if not clients:
        st.info("No clients yet. Click **+ Add new client** to get started.")
        return

    # Filter by search query
    q = query.strip().lower()
    if q:
        filtered = [
            c for c in clients
            if q in c.name.lower() or q in c.domain.lower()
        ]
    else:
        filtered = clients

    if not filtered:
        st.info(f"No clients match \"{query}\".")
        return

    for client in filtered:
        render_client_card(client)

    # Poll while any client is running so the orange progress bars tick live.
    schedule_auto_refresh(clients)


def render_client_card(client: Client) -> None:
    stats = client_stats(client)
    last_run = last_run_date(client)
    status = run_state.get_status(client.id)

    # Status indicator — "live" dot overrides normal status if running
    if status.running:
        dot_html = "<span class='live-dot'></span>"
    elif stats is None:
        dot_html = "<span class='status-dot gray'></span>"
    else:
        pct_idx = stats["indexed"] / stats["total"] * 100 if stats["total"] else 0
        dot_class = "green" if pct_idx >= 90 else "amber"
        dot_html = f"<span class='status-dot {dot_class}'></span>"

    if stats is None:
        summary = "No runs yet"
        metrics_html = (
            "<div class='status-row'>"
            "<span><strong>—</strong> indexed</span>"
            "<span><strong>—</strong> not indexed</span>"
            "<span><strong>—</strong> submitted</span>"
            "</div>"
        )
    else:
        pct_idx = stats["indexed"] / stats["total"] * 100 if stats["total"] else 0
        summary = f"{stats['indexed']}/{stats['total']} indexed ({pct_idx:.0f}%)"
        metrics_html = (
            "<div class='status-row'>"
            f"<span><strong>{stats['indexed']}</strong> indexed</span>"
            f"<span><strong>{stats['not_indexed']}</strong> not indexed</span>"
            f"<span><strong>{stats['submitted']}</strong> submitted</span>"
            "</div>"
        )

    progress_html = ""
    if status.running:
        counter = (
            f"{status.current} / {status.total} URLs"
            if status.total else "starting…"
        )
        progress_html = (
            "<div class='run-progress'>"
            "<div class='run-progress-label'>"
            f"<span>Running · {counter}</span>"
            f"<span>{status.pct:.0f}%</span>"
            "</div>"
            "<div class='run-progress-bar-bg'>"
            f"<div class='run-progress-bar' style='width:{status.pct:.1f}%'></div>"
            "</div>"
            "</div>"
        )

    card_html = (
        "<div class='client-card'>"
        f"<h4>{dot_html}{client.name}</h4>"
        f"<div class='domain'>{client.domain}</div>"
        f"{metrics_html}"
        f"{progress_html}"
        f"<div class='last-run'>Last run: {last_run or 'never'} · {summary}</div>"
        "</div>"
    )

    col_card, col_actions = st.columns([4, 1])
    col_card.markdown(card_html, unsafe_allow_html=True)

    with col_actions:
        st.button(
            "Open",
            key=f"open-{client.id}",
            use_container_width=True,
            on_click=go_to_detail,
            args=(client.id,),
        )
        st.button(
            "Running…" if status.running else "Run",
            key=f"run-card-{client.id}",
            use_container_width=True,
            type="primary",
            disabled=status.running,
            on_click=go_to_detail_and_run,
            args=(client.id,),
        )


# ---------------------------------------------------------------------------
# "This Month" manual-submissions card (rendered inside each client's Overview)
# ---------------------------------------------------------------------------
_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _recheck_pending(client: Client) -> tuple[int, int]:
    """Run inspect() on every manual URL that isn't confirmed indexed. Writes
    fresh status back to the DB. Returns (rechecked_count, error_count)."""
    from gsc import GoogleClient, GoogleClientError  # heavy import

    urls = manual_submit.pending_urls(client.db_path)
    if not urls:
        return 0, 0

    creds = resolve_credentials()
    try:
        gclient = GoogleClient(creds, client.gsc_site_url)
    except GoogleClientError as e:
        st.error(f"Can't authenticate for {client.name}: {e}")
        return 0, len(urls)

    errors = 0
    progress = st.progress(0.0, text=f"Rechecking {len(urls)} URL(s)…")
    for i, url in enumerate(urls, start=1):
        try:
            indexed, reason = gclient.inspect(url)
            manual_submit.update_index_status(
                client.db_path, url, indexed, reason
            )
        except Exception as e:  # noqa: BLE001 — surface errors but keep going
            errors += 1
            manual_submit.update_index_status(
                client.db_path, url, None, f"Recheck error: {e}"
            )
        progress.progress(i / len(urls))
    progress.empty()
    return len(urls), errors


def render_monthly_manual_card(client: Client) -> None:
    """Summary + expandable table of THIS CALENDAR MONTH's manual submissions
    for this client. Month picker lets users browse historical months too."""
    now = datetime.now()
    # Month picker — default to current month, offer the last 6 months.
    month_options: list[tuple[int, int, str]] = []
    y, mo = now.year, now.month
    for _ in range(6):
        month_options.append((y, mo, f"{_MONTH_NAMES[mo - 1]} {y}"))
        mo -= 1
        if mo == 0:
            mo = 12
            y -= 1

    header_col, picker_col, action_col = st.columns([3, 2, 1])
    header_col.markdown("#### 📤 Newly submitted pages")
    selected_idx = picker_col.selectbox(
        "Month",
        options=list(range(len(month_options))),
        format_func=lambda i: month_options[i][2],
        index=0,
        label_visibility="collapsed",
        key=f"month-picker-{client.id}",
    )
    sel_year, sel_month, sel_label = month_options[selected_idx]

    recheck_clicked = action_col.button(
        "Recheck",
        use_container_width=True,
        key=f"recheck-{client.id}",
        help="Re-query Google for the latest indexed status of pending URLs.",
    )

    summary = manual_submit.monthly_summary(client.db_path, sel_year, sel_month)

    if summary["submitted"] == 0 and summary["failed"] == 0:
        st.caption(
            f"No manual submissions for **{client.name}** in {sel_label}. "
            f"Use **Submit URLs** in the sidebar to add newly published pages."
        )
        st.divider()
        return

    # Summary tiles
    m1, m2, m3, m4 = st.columns(4)
    m1.metric(f"Submitted in {sel_label}", summary["submitted"])
    m2.metric("Indexed by Google", summary["indexed"])
    m3.metric("Pending", summary["pending"])
    m4.metric("Failed", summary["failed"])

    # Recheck action (runs after metrics so fresh data is reflected on rerun)
    if recheck_clicked:
        checked, errs = _recheck_pending(client)
        if checked == 0:
            st.info("Nothing to recheck — all URLs confirmed indexed.")
        else:
            st.success(
                f"Rechecked {checked} URL(s)"
                + (f" · {errs} error(s)" if errs else "")
            )
        st.rerun()

    # Expandable table
    rows = manual_submit.monthly_submissions(client.db_path, sel_year, sel_month)
    if rows:
        with st.expander(
            f"Show {len(rows)} submission(s) from {sel_label}", expanded=False
        ):
            df = pd.DataFrame([
                {
                    "URL": r["url"],
                    "Submitted": "✓" if r["submitted"] else "✗",
                    "Submitted at": (r["submitted_at"][:16].replace("T", " ")
                                     if r["submitted_at"] else "—"),
                    "Indexed": (
                        "✅" if r["indexed"] == "true"
                        else "❌" if r["indexed"] == "false"
                        else "⏳"
                    ),
                    "Last checked": (r["last_checked"][:16].replace("T", " ")
                                     if r["last_checked"] else "—"),
                    "Attempts": r["attempts"],
                    "Notes": r["notes"],
                }
                for r in rows
            ])
            st.dataframe(df, use_container_width=True, hide_index=True, height=320)
    st.divider()


# ---------------------------------------------------------------------------
# DETAIL VIEW
# ---------------------------------------------------------------------------
def render_detail_view() -> None:
    clients = load_clients()
    client = next(
        (c for c in clients if c.id == st.session_state.selected_client_id), None
    )
    if client is None:
        st.error("Client not found.")
        st.button("Back to clients", on_click=go_to_list)
        return

    bc_col_1, _ = st.columns([1, 5])
    bc_col_1.button("← All clients", on_click=go_to_list)

    render_header(
        client.name,
        f"{client.domain} · sitemap: {client.sitemap_url}",
    )

    # If auto_run is set (user clicked Run from the card), kick off the
    # background run now. Non-blocking — the rest of the view renders normally
    # and render_run_status() reads live progress from the status file.
    if st.session_state.auto_run:
        st.session_state.auto_run = False
        start_run(client)

    status = run_state.get_status(client.id)
    show_run_area = status.running or bool(status.finished_at)
    run_output_area = st.container() if show_run_area else None
    if show_run_area:
        st.divider()

    tab_overview, tab_run, tab_history = st.tabs(["Overview", "Run", "History"])

    # --- OVERVIEW TAB ---
    with tab_overview:
        render_monthly_manual_card(client)

        stats = client_stats(client)
        last_run = last_run_date(client)

        if stats is None:
            st.info(
                f"No runs for **{client.name}** yet. "
                "Go to the **Run** tab to kick off the first check."
            )
        else:
            st.caption(f"Last run: {last_run}")
            render_summary_metrics(stats)

            latest_csv = get_client_csvs(client)[0]
            df = pd.read_csv(latest_csv)
            not_indexed = df[
                ~df["indexed"].astype(str).str.lower().isin(INDEXED_TRUE)
            ]

            if not not_indexed.empty:
                st.markdown("#### Why URLs are not indexed")
                breakdown = (
                    not_indexed["notes"]
                    .fillna("(no reason listed)")
                    .value_counts()
                    .rename_axis("Reason")
                    .reset_index(name="Count")
                )
                st.dataframe(breakdown, use_container_width=True, hide_index=True)
            else:
                st.success("Every URL in the sitemap is indexed.")

    # --- RUN TAB ---
    with tab_run:
        st.markdown(f"### Run check for {client.name}")
        st.caption(
            "Clicking Run executes the indexing check. A typical run takes "
            "5–20 minutes depending on sitemap size. Leave this tab open "
            "until it finishes."
        )

        is_running_now = status.running
        run_col, _ = st.columns([1, 4])
        run_clicked = run_col.button(
            "Running…" if is_running_now else "Run now",
            type="primary",
            use_container_width=True,
            disabled=is_running_now,
            key=f"run-{client.id}",
        )

        if run_clicked:
            start_run(client)
            st.rerun()

    # --- HISTORY TAB ---
    with tab_history:
        st.markdown("### Past runs")
        csvs = get_client_csvs(client)
        if not csvs:
            st.info("No runs recorded yet.")
        else:
            for csv_path in csvs:
                ts = datetime.fromtimestamp(csv_path.stat().st_mtime)
                with st.expander(
                    f"{csv_path.stem}  —  written {ts.strftime('%Y-%m-%d %H:%M')}"
                ):
                    df = pd.read_csv(csv_path)
                    render_summary_metrics(summarize_report(df))
                    st.dataframe(
                        df, use_container_width=True, hide_index=True, height=360
                    )
                    with open(csv_path, "rb") as f:
                        st.download_button(
                            label="Download CSV",
                            data=f.read(),
                            file_name=f"{client.id}-{csv_path.name}",
                            mime="text/csv",
                            key=f"dl-{client.id}-{csv_path.name}",
                        )

    # Populate the reserved run-output area at the top of the page with
    # the current status snapshot.
    if run_output_area is not None:
        with run_output_area:
            render_run_status(client)

    # Poll loop: if a run is active, pause briefly and rerun to pick up fresh
    # progress from the status file. Cheap — one JSON read per tick.
    schedule_auto_refresh([client])


# ---------------------------------------------------------------------------
# Run execution — non-blocking. Runs happen in a background thread; progress
# is written to a status file and polled from here.
# ---------------------------------------------------------------------------
def start_run(client: Client) -> bool:
    """Kick off a background indexing run for this client (no-op if already
    running). Returns True if a new run was started."""
    client.reports_dir.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)

    creds_value = resolve_credentials()

    env = os.environ.copy()
    env.update({
        "SITEMAP_URL": client.sitemap_url,
        "GSC_SITE_URL": client.gsc_site_url,
        "GOOGLE_CREDENTIALS": creds_value,
        "INDEXING_DB_PATH": str(client.db_path),
        "REPORTS_DIR": str(client.reports_dir),
        "MAX_SUBMISSIONS_PER_RUN": "180",
        "MAX_SUBMIT_ATTEMPTS_PER_URL": "5",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
    })

    return run_state.start_background_run(
        client_id=client.id,
        cmd=[sys.executable, "main.py", "run"],
        cwd=PROJECT_DIR,
        env=env,
    )


def render_run_status(client: Client) -> None:
    """Render the current run status (banner, progress, metrics, log, result)
    from the status file. Called on every rerun while a run is active; the
    list view schedules auto-reruns so this refreshes live."""
    status = run_state.get_status(client.id)

    # Nothing to show if never run and not running
    if not status.running and not status.finished_at and status.current == 0:
        return

    # Banner
    if status.running:
        st.markdown(
            "<div class='run-banner'>"
            "<div class='run-banner-title'>"
            "<span class='live-dot'></span>"
            f"Running indexing check for {client.name}"
            "</div>"
            "<div class='run-banner-sub'>"
            f"{client.domain} · started {status.started_at or '…'}"
            "</div>"
            "</div>",
            unsafe_allow_html=True,
        )

    # Progress bar
    pct_frac = min(status.pct / 100.0, 1.0)
    if status.running and not status.total:
        progress_text = "Starting run…"
    elif status.running:
        progress_text = (
            f"Inspecting URL {status.current} of {status.total} · "
            f"{status.pct:.0f}%"
        )
    elif status.error:
        progress_text = f"Failed · {status.error}"
    else:
        final_total = status.total or status.current
        progress_text = f"Done · {final_total} URLs inspected · 100%"
        pct_frac = 1.0
    st.progress(pct_frac, text=progress_text)

    # Metrics row
    m1, m2, m3 = st.columns(3)
    m1.metric("URLs inspected", f"{status.current:,}")
    m2.metric(
        "Total in sitemap", f"{status.total:,}" if status.total else "—"
    )
    m3.metric("Progress", f"{status.pct:.0f}%")

    # Log tail
    if status.log_tail:
        st.code("\n".join(status.log_tail[-40:]), language="text")

    # Completion
    if not status.running and status.finished_at:
        if status.error:
            st.error(f"Run failed: {status.error}")
        else:
            st.success(f"Run completed for {client.name}.")
            today_csv = (
                client.reports_dir
                / f"{datetime.now().strftime('%Y-%m-%d')}.csv"
            )
            if today_csv.exists():
                df = pd.read_csv(today_csv)
                render_summary_metrics(summarize_report(df))
                with open(today_csv, "rb") as f:
                    st.download_button(
                        label=f"Download {today_csv.name}",
                        data=f.read(),
                        file_name=f"{client.id}-{today_csv.name}",
                        mime="text/csv",
                        type="primary",
                        key=f"run-dl-{client.id}-{today_csv.name}",
                    )


def any_run_active(clients: list[Client]) -> bool:
    return any(run_state.is_running(c.id) for c in clients)


def schedule_auto_refresh(clients: list[Client], interval_s: float = 2.0) -> None:
    """If any client has a live run, pause briefly and rerun so status files
    get re-read. This is our poll loop — cheap because reads are a single
    JSON file per client."""
    if any_run_active(clients):
        time.sleep(interval_s)
        st.rerun()


# ---------------------------------------------------------------------------
# ADD CLIENT VIEW
# ---------------------------------------------------------------------------
def render_add_view() -> None:
    bc_col_1, _ = st.columns([1, 5])
    bc_col_1.button("← All clients", on_click=go_to_list, key="add-back")

    render_header(
        "Add a new client",
        "Add a client site to start tracking its Google indexing status.",
    )

    st.info(
        "Heads up: before running a check on this client, their Search Console "
        "property must already exist, and the service account bot "
        "(`indexing-monitor-bot@indexing-monitor-494117.iam.gserviceaccount.com`) "
        "must be added as an **Owner** in that property's Users and permissions."
    )

    with st.form("add-client"):
        name = st.text_input(
            "Client name",
            placeholder="e.g. Acme Corp",
        )
        domain_or_url = st.text_input(
            "Website",
            placeholder="https://www.example.com/",
        )
        sitemap_url = st.text_input(
            "Sitemap URL",
            placeholder="https://www.example.com/sitemap.xml",
            help="Leave blank to auto-fill as <website>/sitemap.xml",
        )
        gsc_site_url = st.text_input(
            "Search Console property",
            placeholder="https://www.example.com/  or  sc-domain:example.com",
            help="Must match exactly what Search Console has on file.",
        )

        submitted = st.form_submit_button("Save client", type="primary")

    if submitted:
        if not name or not domain_or_url:
            st.error("Client name and website are required.")
            return

        website = domain_or_url.strip()
        if not website.startswith(("http://", "https://")):
            website = "https://" + website

        parsed = urlparse(website)
        domain = parsed.netloc or website

        if not sitemap_url.strip():
            sitemap_url = website.rstrip("/") + "/sitemap.xml"
        if not gsc_site_url.strip():
            gsc_site_url = website if website.endswith("/") else website + "/"

        clients = load_clients()
        base_id = slugify(name)
        new_id = base_id
        n = 1
        while any(c.id == new_id for c in clients):
            n += 1
            new_id = f"{base_id}-{n}"

        new_client = Client(
            id=new_id,
            name=name.strip(),
            domain=domain,
            sitemap_url=sitemap_url.strip(),
            gsc_site_url=gsc_site_url.strip(),
            created_at=datetime.now().date().isoformat(),
        )
        clients.append(new_client)
        save_clients(clients)

        st.success(f"Added **{new_client.name}**. Opening their dashboard…")
        go_to_detail(new_client.id)
        st.rerun()


# ---------------------------------------------------------------------------
# SUBMIT URLS VIEW
# ---------------------------------------------------------------------------
def _reset_submit_state() -> None:
    st.session_state.submit_routed = None
    st.session_state.submit_overrides = {}
    st.session_state.submit_results = None


def _client_by_id(clients: list[Client], cid: str) -> Client | None:
    return next((c for c in clients if c.id == cid), None)


def _do_manual_submit(
    clients: list[Client],
    grouped: dict[str, list[str]],
) -> list[manual_submit.SubmissionResult]:
    """Submit each URL via GSC using its client's property. Runs synchronously
    because a handful of URLs per client takes seconds, not minutes."""
    from gsc import GoogleClient, GoogleClientError  # lazy import — heavy deps

    creds = resolve_credentials()
    results: list[manual_submit.SubmissionResult] = []

    # One GoogleClient per client (each has its own GSC property).
    progress_total = sum(len(urls) for urls in grouped.values())
    progress_bar = st.progress(0.0, text="Submitting…")
    done = 0

    for client_id, urls in grouped.items():
        client = _client_by_id(clients, client_id)
        if client is None:
            for url in urls:
                results.append(manual_submit.SubmissionResult(
                    url, client_id, False, "Client not found"
                ))
                manual_submit.record_submission(
                    Path(f"data/{client_id}.db"), url, False, "Client not found"
                )
                done += 1
                progress_bar.progress(done / progress_total)
            continue

        try:
            gclient = GoogleClient(creds, client.gsc_site_url)
        except GoogleClientError as e:
            for url in urls:
                msg = f"Auth failed: {e}"
                results.append(manual_submit.SubmissionResult(url, client_id, False, msg))
                manual_submit.record_submission(client.db_path, url, False, msg)
                done += 1
                progress_bar.progress(done / progress_total)
            continue

        for url in urls:
            progress_bar.progress(
                done / progress_total,
                text=f"Submitting {url[:60]}…",
            )
            try:
                gclient.submit_url(url)
                ok, msg = True, "Submitted to Indexing API"
            except GoogleClientError as e:
                ok, msg = False, f"Google error: {e}"
            except Exception as e:  # noqa: BLE001 — surface any failure to the UI
                ok, msg = False, f"Error: {e}"

            manual_submit.record_submission(client.db_path, url, ok, msg)
            results.append(manual_submit.SubmissionResult(url, client_id, ok, msg))
            done += 1
            progress_bar.progress(done / progress_total)

    progress_bar.empty()
    return results


def render_submit_view() -> None:
    bc_col_1, _ = st.columns([1, 5])
    bc_col_1.button("← All clients", on_click=go_to_list, key="submit-back")

    render_header(
        "Submit URLs for indexing",
        "Paste newly published pages from any client. We'll auto-route each "
        "URL to its Search Console property and submit it to Google's "
        "Indexing API.",
        eyebrow="Manual submissions",
    )

    clients = load_clients()
    if not clients:
        st.info("Add a client first — the Submit URLs flow uses each client's "
                "Search Console property.")
        return

    # --- INPUT STAGE ---
    st.markdown("#### 1. Paste URLs")
    st.caption("One URL per line. Mix and match clients — we'll sort them.")

    input_value = st.text_area(
        "URLs",
        value=st.session_state.submit_input,
        height=180,
        placeholder=(
            "https://www.msplaunchpad.com/blog/new-post\n"
            "https://www.techlocity.com/locations/dallas\n"
            "https://www.ajtc.net/blog/security-update"
        ),
        label_visibility="collapsed",
        key="submit_input_area",
    )

    col_a, col_b = st.columns([1, 1])
    if col_a.button("Analyze URLs", type="primary", use_container_width=True):
        st.session_state.submit_input = input_value
        urls = [line.strip() for line in input_value.splitlines() if line.strip()]
        st.session_state.submit_routed = manual_submit.route_urls(urls, clients)
        st.session_state.submit_overrides = {}
        st.session_state.submit_results = None
        st.rerun()

    if col_b.button("Clear", use_container_width=True):
        st.session_state.submit_input = ""
        _reset_submit_state()
        st.rerun()

    routed = st.session_state.submit_routed
    if routed is None:
        return

    # --- PREVIEW STAGE ---
    st.divider()
    st.markdown("#### 2. Review routing")

    if not routed:
        st.warning("No URLs to submit. Paste some above and hit Analyze.")
        return

    # Apply any manual overrides the user has set for unknowns
    overrides = st.session_state.submit_overrides
    effective_client: dict[str, str | None] = {}
    for r in routed:
        effective_client[r.url] = overrides.get(r.url, r.client_id)

    # Group by effective client for the preview + submit
    grouped: dict[str, list[str]] = {}
    unknowns: list[str] = []
    for url, cid in effective_client.items():
        if cid:
            grouped.setdefault(cid, []).append(url)
        else:
            unknowns.append(url)

    # Grouped preview tiles
    matched_count = sum(len(v) for v in grouped.values())
    unknown_count = len(unknowns)
    invalid_count = sum(1 for r in routed if r.reason == "Not a valid URL")

    c1, c2, c3 = st.columns(3)
    c1.metric("Ready to submit", matched_count)
    c2.metric("Unknown domain", unknown_count - invalid_count)
    c3.metric("Invalid URLs", invalid_count)

    for client_id, urls in grouped.items():
        client = _client_by_id(clients, client_id)
        label = client.name if client else client_id
        with st.expander(f"**{label}** — {len(urls)} URL(s) · {client.gsc_site_url if client else ''}", expanded=True):
            for u in urls:
                st.markdown(f"- `{u}`")

    if unknowns:
        with st.expander(f"⚠️ Unknown domain — {len(unknowns)} URL(s)", expanded=True):
            st.caption(
                "These URLs don't match any known client. Pick one manually, "
                "or leave blank to skip."
            )
            client_options = ["(skip)"] + [c.id for c in clients]
            client_labels = {c.id: c.name for c in clients}
            for idx, u in enumerate(unknowns):
                # Skip invalids — can't submit a malformed URL regardless of client
                reason = next((r.reason for r in routed if r.url == u), "")
                if reason == "Not a valid URL":
                    st.markdown(f"- ❌ `{u}` *(invalid — will be skipped)*")
                    continue

                col_url, col_pick = st.columns([3, 2])
                col_url.markdown(f"`{u}`")
                current = overrides.get(u, "(skip)")
                choice = col_pick.selectbox(
                    "Assign to",
                    options=client_options,
                    index=client_options.index(current) if current in client_options else 0,
                    format_func=lambda cid: "(skip)" if cid == "(skip)" else client_labels.get(cid, cid),
                    key=f"override-{idx}",
                    label_visibility="collapsed",
                )
                if choice == "(skip)":
                    overrides.pop(u, None)
                else:
                    overrides[u] = choice

    # --- SUBMIT STAGE ---
    st.divider()
    st.markdown("#### 3. Submit")

    if matched_count == 0:
        st.info("No URLs are ready to submit yet. Assign unknowns above or paste new URLs.")
        return

    if not resolve_credentials():
        st.error(
            "No Google credentials found. Drop `service-account.json` in the "
            "project root, set the `GOOGLE_CREDENTIALS` env var, or paste it "
            "into Streamlit Cloud secrets."
        )
        return

    submit_clicked = st.button(
        f"Submit {matched_count} URL(s) to Google",
        type="primary",
        use_container_width=True,
    )
    if submit_clicked:
        # Re-build grouped dict from effective_client in case overrides changed
        final_grouped: dict[str, list[str]] = {}
        for url, cid in effective_client.items():
            if cid:
                final_grouped.setdefault(cid, []).append(url)
        st.session_state.submit_results = _do_manual_submit(clients, final_grouped)
        st.rerun()

    # --- RESULTS STAGE ---
    results = st.session_state.submit_results
    if results is not None:
        st.divider()
        st.markdown("#### 4. Results")

        ok_count = sum(1 for r in results if r.ok)
        fail_count = len(results) - ok_count
        r1, r2 = st.columns(2)
        r1.metric("Submitted successfully", ok_count)
        r2.metric("Failed", fail_count)

        # Group results by client for easier reading
        by_client: dict[str, list[manual_submit.SubmissionResult]] = {}
        for r in results:
            by_client.setdefault(r.client_id, []).append(r)

        for cid, rs in by_client.items():
            client = _client_by_id(clients, cid)
            label = client.name if client else cid
            ok = sum(1 for r in rs if r.ok)
            with st.expander(f"**{label}** — {ok}/{len(rs)} succeeded", expanded=(ok != len(rs))):
                for r in rs:
                    icon = "✅" if r.ok else "❌"
                    st.markdown(f"{icon} `{r.url}` — {r.message}")

        st.caption(
            "Results recorded in each client's database. Open the client's "
            "dashboard to see the updated **This Month** card."
        )

        if st.button("Submit another batch", use_container_width=True):
            st.session_state.submit_input = ""
            _reset_submit_state()
            st.rerun()


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------
if st.session_state.view == "add":
    render_add_view()
elif st.session_state.view == "submit":
    render_submit_view()
elif st.session_state.view == "detail" and st.session_state.selected_client_id:
    render_detail_view()
else:
    render_list_view()


# ---------------------------------------------------------------------------
# Footer
# ---------------------------------------------------------------------------
st.markdown(
    "<div class='mspl-footer'>"
    "<strong>MSP LAUNCHPAD</strong>&nbsp;™ "
    "&middot; Indexing Monitor &middot; Internal SEO tooling"
    "</div>",
    unsafe_allow_html=True,
)
