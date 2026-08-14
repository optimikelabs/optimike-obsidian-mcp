from pathlib import Path
import json

package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
package["scripts"]["test:governed-frontmatter"] = (
    "npm run build && node scripts/test-governed-frontmatter-model.mjs "
    "&& node scripts/test-frontmatter-p1-compiler.mjs "
    "&& node scripts/test-frontmatter-p1-idempotency.mjs "
    "&& node scripts/test-governed-frontmatter-mcp.mjs "
    "&& node scripts/test-governed-frontmatter-http.mjs"
)
package_path.write_text(
    json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

contract_path = Path("scripts/test-governed-frontmatter-doc-contract.mjs")
contract = contract_path.read_text(encoding="utf-8")
old = (
    '  "npm run build && node scripts/test-governed-frontmatter-model.mjs '
    '&& node scripts/test-frontmatter-p1-compiler.mjs '
    '&& node scripts/test-governed-frontmatter-mcp.mjs '
    '&& node scripts/test-governed-frontmatter-http.mjs",'
)
new = (
    '  "npm run build && node scripts/test-governed-frontmatter-model.mjs '
    '&& node scripts/test-frontmatter-p1-compiler.mjs '
    '&& node scripts/test-frontmatter-p1-idempotency.mjs '
    '&& node scripts/test-governed-frontmatter-mcp.mjs '
    '&& node scripts/test-governed-frontmatter-http.mjs",'
)
if contract.count(old) != 1:
    raise SystemExit(f"expected one P1 script assertion, found {contract.count(old)}")
contract = contract.replace(old, new, 1)
anchor = '  "scripts/test-frontmatter-p1-compiler.mjs",\n'
if contract.count(anchor) != 1:
    raise SystemExit(f"expected one compiler access anchor, found {contract.count(anchor)}")
contract = contract.replace(
    anchor,
    anchor + '  "scripts/test-frontmatter-p1-idempotency.mjs",\n',
    1,
)
contract_path.write_text(contract, encoding="utf-8")

package_test_path = Path("scripts/test-package-contents.mjs")
package_test = package_test_path.read_text(encoding="utf-8")
anchor = '  "scripts/test-governed-frontmatter-mcp.mjs",\n'
if package_test.count(anchor) != 1:
    raise SystemExit(f"expected one package P1 anchor, found {package_test.count(anchor)}")
package_test = package_test.replace(
    anchor,
    '  "scripts/test-frontmatter-p1-idempotency.mjs",\n' + anchor,
    1,
)
package_test_path.write_text(package_test, encoding="utf-8")

print("Integrated P1 cross-process idempotency and P0 digest gates.")
