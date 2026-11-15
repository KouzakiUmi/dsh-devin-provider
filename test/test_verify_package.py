import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class VerifyPackageTest(unittest.TestCase):
    def test_manifest_and_lib_exports(self):
        pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(pkg["name"], "dsh-devin-provider")
        self.assertTrue((ROOT / pkg["main"]).is_file())
        self.assertTrue((ROOT / pkg["exports"]["./client"]).is_file())
        self.assertTrue((ROOT / pkg["exports"]["./icon"]).is_file())
        self.assertTrue((ROOT / pkg["dsh"]["bundle"]["patch"]).is_file())

        for loc in ("en.json", "zh.json"):
            data = json.loads((ROOT / "locale" / loc).read_text(encoding="utf-8"))
            self.assertIn("title", data.get("meta", {}))
            self.assertIn("description", data.get("meta", {}))

    def test_lib_relative_imports_resolve(self):
        lib = ROOT / "lib"
        self.assertTrue(lib.is_dir())
        for path in lib.glob("*.mjs"):
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r"""from\s+['"](\.[^'"]+)['"]""", text):
                target = (path.parent / match.group(1)).resolve()
                self.assertTrue(target.is_file(), f"Missing import {match.group(1)} in {path.name}")

    def test_lib_client_bundle_format(self):
        client = (ROOT / "lib" / "client.js").read_text(encoding="utf-8")
        self.assertIn("window.__ModuleLoader__.load", client)
        self.assertIn("id:'dsh-devin-provider'", client)
        self.assertNotIn("from 'node:", client)


if __name__ == "__main__":
    unittest.main()
