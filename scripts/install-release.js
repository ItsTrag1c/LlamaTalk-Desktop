import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const { version } = JSON.parse(readFileSync("./package.json", "utf8"));
const installer = `E:\\LlamaTalk Files\\Installers\\LlamaTalk Desktop_${version}_x64-setup.exe`;

if (!existsSync(installer)) {
  console.error(`Error: installer not found at ${installer}`);
  console.error("Run npm run tauri build first to generate the installer.");
  process.exit(1);
}

console.log(`Installing LlamaTalk Desktop v${version} to Program Files (UAC prompt will appear)...`);
execSync(
  `powershell -NoProfile -Command "Start-Process -FilePath '${installer}' -ArgumentList '/S' -Verb RunAs -Wait"`,
  { stdio: "inherit" }
);
console.log("Done. Program Files updated to v" + version);
