"""Cron: import path of the restart-safe external worker.

The worker is spawned as ``sys.executable -m cron.scheduler``. Its entry module is
``cron.scheduler``, not ``hermes_cli.main``, so nothing bootstraps the gateway's checkout
onto its ``sys.path``; historically it imported ``cron`` only through the implicit ``-m``
cwd entry. That entry is gone under ``PYTHONSAFEPATH`` and useless when the venv's
editable install maps a moved/deleted checkout -- the worker then dies with
"No module named 'cron'" before its ownership ack (#112729, hypothesised cause).

The shared subprocess sanitizer strips Hermes-owned PYTHONPATH entries because user
children must not see our tree. This child IS Hermes, so the pin is applied *after* the
env is built, on the sanitized env -- but the sanitizer's site-packages drop must NOT
stand for this child specifically: ``cron/jobs.py``'s own import graph now reaches
third-party dependencies (``agent.secret_scope`` -> ``utils`` -> ``hermes_yaml`` ->
``ruamel.yaml``), so the worker needs the committed venv's site-packages back on its
PYTHONPATH too, not just the repo root -- without it every cron job dispatched through
the external-worker path dies with ``ModuleNotFoundError`` before the ownership ack.
"""

from __future__ import annotations

import os
import sysconfig
from pathlib import Path


def _installed_purelib() -> Path | None:
    try:
        return Path(sysconfig.get_paths()["purelib"]).resolve()
    except (KeyError, OSError):
        return None


def _committed_venv_site_packages(repo_root: Path) -> Path | None:
    """The site-packages of the venv PM committed for this install, or ``None``.

    Mirrors ``pm.environments.activate_dependencies``'s own resolution so the worker's
    dependency environment matches the parent gateway's exactly. ``None`` for anything
    that isn't a self-managed git install with a recorded generation (sealed payload,
    developer checkout, Nix) -- those either need nothing extra or the parent process's
    own PYTHONPATH already covers it another way.
    """
    try:
        from pm.environments import committed_venv, site_packages
    except ImportError:
        return None
    try:
        venv = committed_venv(repo_root)
    except Exception:
        return None
    if venv is None:
        return None
    try:
        candidate = site_packages(venv)
    except Exception:
        return None
    return candidate if candidate.is_dir() else None


def pin_hermes_tree_on_pythonpath(worker_env: dict, repo_root: Path) -> dict:
    """Prepend ``repo_root`` (and, if resolvable, the committed venv's site-packages) to
    the worker env's own PYTHONPATH (never ``os.environ``'s).

    Skipped when ``repo_root`` is the interpreter's ``purelib``: under a wheel / pipx /
    uv-tool install ``cron/`` lives in site-packages itself, which is already importable,
    and pinning it would move site-packages ahead of the stdlib on ``sys.path``.
    """
    root = str(repo_root)
    if _installed_purelib() == Path(root).resolve():
        return worker_env
    to_pin = [root]
    site_pkgs = _committed_venv_site_packages(repo_root)
    if site_pkgs is not None:
        to_pin.append(str(site_pkgs))
    existing = [e for e in worker_env.get("PYTHONPATH", "").split(os.pathsep) if e]
    worker_env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys([*to_pin, *existing]))
    return worker_env
