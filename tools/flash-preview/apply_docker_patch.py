#!/usr/bin/env python3
"""Patch web router and IDE pug template during Docker image build."""
import pathlib


def patch_router(web_root: pathlib.Path) -> None:
    target = web_root / "app" / "src" / "router.mjs"
    content = target.read_text(encoding="utf-8")
    if "/flash-preview" in content:
        return
    import_line = "import { preview } from './Features/FlashPreview.mjs'\n"
    anchor = "  webRouter.get(\n    '/project/:Project_id/entities'"
    if anchor not in content:
        raise RuntimeError(f"Anchor not found in {target}")
    route_block = (
        "  webRouter.post(\n"
        "    '/project/:Project_id/flash-preview',\n"
        "    AuthenticationController.requireLogin(),\n"
        "    AuthorizationMiddleware.ensureUserCanReadProject,\n"
        "    preview\n"
        "  )\n"
    )
    target.write_text(
        import_line + content.replace(anchor, route_block + anchor, 1),
        encoding="utf-8",
    )


def patch_ide_template(web_root: pathlib.Path) -> None:
    target = web_root / "app" / "views" / "project" / "ide-react.pug"
    content = target.read_text(encoding="utf-8")
    if "flash-preview-editor.js" in content:
        return
    addition = (
        "\nblock append foot-scripts\n"
        "\tscript(nonce=scriptNonce src='/flash-preview-editor.js' defer)\n"
    )
    target.write_text(content + addition, encoding="utf-8")


if __name__ == "__main__":
    root = pathlib.Path("/overleaf/services/web")
    patch_router(root)
    patch_ide_template(root)
