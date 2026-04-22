// Pure Node.js module - uses adm-zip for cross-platform zip handling
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

async function extractZipToDirectory(zipPath, targetDir) {
  // Ensure target directory exists
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
  } catch (error) {
    throw new Error(`Failed to extract zip: ${error.message}`);
  }
}

async function readFileFromZip(zipPath, filename) {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry(filename);

    if (!entry) {
      return null;
    }

    return zip.readAsText(entry);
  } catch (error) {
    throw new Error(`Failed to read file from zip: ${error.message}`);
  }
}

module.exports = {
  extractZipToDirectory,
  readFileFromZip,
};
