// Pre-release (preview.yaml) must use an odd minor version (1.3.x, 1.5.x, …).
const fs = require("fs");

const packageJson = fs.readFileSync("package.json");
const packageJsonJson = JSON.parse(packageJson);
const version = packageJsonJson.version;
const minor = parseInt(version.split(".")[1], 10);
if (minor % 2 === 0) {
  throw new Error(
    "Pre-release requires an odd-numbered minor version (e.g. 1.5.x). " +
      "Run the VSCode Pre-release workflow or bump the minor before publishing.",
  );
}
