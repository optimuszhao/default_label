#!/usr/bin/env python3
"""Build local mock SDK source archives for the Default Label demo."""

from __future__ import annotations

import shutil
import tarfile
import tempfile
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = PACKAGE_ROOT / "lib"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build_sdist(
    temp_root: Path,
    distribution: str,
    version: str,
    package_name: str,
    init_code: str,
    install_requires: list[str] | None = None,
) -> Path:
    source_dir = temp_root / f"{distribution}-{version}"
    package_dir = source_dir / package_name

    write_text(package_dir / "__init__.py", init_code)
    setup_code = f"""from setuptools import setup, find_packages

setup(
    name="{distribution}",
    version="{version}",
    packages=find_packages(),
    install_requires={install_requires or []!r},
)
"""
    write_text(source_dir / "setup.py", setup_code)

    archive_path = LIB_DIR / f"{distribution}-{version}.tar.gz"
    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(source_dir, arcname=source_dir.name)

    return archive_path


def main() -> int:
    LIB_DIR.mkdir(parents=True, exist_ok=True)

    api_archive = LIB_DIR / "naie_api-23.3.3.tar.gz"
    impl_archive = LIB_DIR / "naie_impl_network-23.1.1.1.tar.gz"
    for archive in (api_archive, impl_archive):
        if archive.exists():
            archive.unlink()

    with tempfile.TemporaryDirectory(prefix="default-label-sdk-") as temp_dir:
        temp_root = Path(temp_dir)

        api_path = build_sdist(
            temp_root=temp_root,
            distribution="naie_api",
            version="23.3.3",
            package_name="naie_api",
            init_code='''"""Mock naie_api SDK."""

__version__ = "23.3.3"


def get_api_version():
    return __version__
''',
        )

        impl_path = build_sdist(
            temp_root=temp_root,
            distribution="naie_impl_network",
            version="23.1.1.1",
            package_name="naie_impl_network",
            install_requires=["naie_api==23.3.3"],
            init_code='''"""Mock naie_impl_network SDK."""

from naie_api import get_api_version

__version__ = "23.1.1.1"


def get_network_impl_version():
    return __version__


def get_network_label_result(input_text):
    return {
        "sdk": "naie_impl_network",
        "version": __version__,
        "api_version": get_api_version(),
        "input_text": input_text,
        "mock_label": "network_default_label",
    }
''',
        )

    print(f"[build_mock_sdks.py] generated: {api_path}")
    print(f"[build_mock_sdks.py] generated: {impl_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
