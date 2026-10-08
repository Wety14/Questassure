/**
 * @file package_vsix.js
 * @brief Script de création automatique d'un package .vsix pour Questassure.
 * Génère une archive ZIP/VSIX standardisée et nettoyée (0 extra fields)
 * 100% conforme avec Open VSX Registry et VS Code Marketplace.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const rootDir = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const vsixName = `questassure-vscode-${version}.vsix`;
const targetVsixPath = path.join(rootDir, vsixName);

console.log(`Building and packaging Questassure VHDL v${version} -> ${vsixName}...`);

// 1. Build bundles
console.log('Running npm run build...');
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

// 2. Prepare manifest & XML content
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".html" ContentType="text/html"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`;

const vsixManifestXml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="questassure-vscode" Version="${version}" Publisher="DARIER--LEGRAND" />
		<DisplayName>Questassure VHDL</DisplayName>
		<Description xml:space="preserve">VHDL formatting, syntax checking with GHDL diagnostics, testbench simulations, and MCP AI Server.</Description>
		<Tags>vhdl,VHDL,mcp,__ext_vhd,__ext_vhdl</Tags>
		<Categories>Programming Languages,Linters,Formatters</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.60.0" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
			<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
		</Properties>
		<License>extension/LICENSE.txt</License>
		<Icon>extension/icon.png</Icon>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
	</Assets>
</PackageManifest>`;

// 3. Clean ZIP Writer implementation (strictly 0 extra fields to prevent Open VSX rejection)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c;
}

function computeCrc32(buffer) {
    if (typeof zlib.crc32 === 'function') {
        return zlib.crc32(buffer);
    }
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
}

function getDosDateTime(date = new Date()) {
    const time = ((date.getHours() & 0x1f) << 11) |
                 ((date.getMinutes() & 0x3f) << 5) |
                 ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dt = (((date.getFullYear() - 1980) & 0x7f) << 9) |
               (((date.getMonth() + 1) & 0x0f) << 5) |
               (date.getDate() & 0x1f);
    return { time, date: dt };
}

class CleanZipWriter {
    constructor() {
        this.entries = [];
    }

    addFile(relativePath, data) {
        const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        this.entries.push({ path: normalizedPath, data: buffer });
    }

    toBuffer() {
        const { time: dosTime, date: dosDate } = getDosDateTime();
        const localChunks = [];
        const cdChunks = [];
        let offset = 0;

        for (const entry of this.entries) {
            const nameBuf = Buffer.from(entry.path, 'utf8');
            const uncompressedSize = entry.data.length;
            const crc = computeCrc32(entry.data);
            const compressedData = zlib.deflateRawSync(entry.data, { level: 9 });
            const compressedSize = compressedData.length;

            // Local File Header (30 bytes + name length, 0 extra fields)
            const localHeader = Buffer.alloc(30);
            localHeader.writeUInt32LE(0x04034b50, 0); // signature
            localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
            localHeader.writeUInt16LE(0x0800, 6);     // flags: UTF-8 filename (bit 11)
            localHeader.writeUInt16LE(8, 8);          // compression method: Deflate
            localHeader.writeUInt16LE(dosTime, 10);   // last mod time
            localHeader.writeUInt16LE(dosDate, 12);   // last mod date
            localHeader.writeUInt32LE(crc, 14);       // crc32
            localHeader.writeUInt32LE(compressedSize, 18);   // compressed size
            localHeader.writeUInt32LE(uncompressedSize, 22); // uncompressed size
            localHeader.writeUInt16LE(nameBuf.length, 26);   // file name length
            localHeader.writeUInt16LE(0, 28);                // extra field length: 0!

            const localOffset = offset;
            localChunks.push(localHeader, nameBuf, compressedData);
            offset += localHeader.length + nameBuf.length + compressedData.length;

            // Central Directory Header (46 bytes + name length, 0 extra fields)
            const cdHeader = Buffer.alloc(46);
            cdHeader.writeUInt32LE(0x02014b50, 0); // signature
            cdHeader.writeUInt16LE(0x0314, 4);     // version made by (Unix 2.0)
            cdHeader.writeUInt16LE(20, 6);         // version needed to extract (2.0)
            cdHeader.writeUInt16LE(0x0800, 8);     // flags: UTF-8 filename (bit 11)
            cdHeader.writeUInt16LE(8, 10);         // compression method: Deflate
            cdHeader.writeUInt16LE(dosTime, 12);   // last mod time
            cdHeader.writeUInt16LE(dosDate, 14);   // last mod date
            cdHeader.writeUInt32LE(crc, 16);       // crc32
            cdHeader.writeUInt32LE(compressedSize, 20);   // compressed size
            cdHeader.writeUInt32LE(uncompressedSize, 24); // uncompressed size
            cdHeader.writeUInt16LE(nameBuf.length, 28);   // file name length
            cdHeader.writeUInt16LE(0, 30);                // extra field length: 0!
            cdHeader.writeUInt16LE(0, 32);                // comment length: 0
            cdHeader.writeUInt16LE(0, 34);                // disk number start: 0
            cdHeader.writeUInt16LE(0, 36);                // internal file attributes
            cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external file attributes (-rw-r--r--)
            cdHeader.writeUInt32LE(localOffset, 42);      // relative offset of local header

            cdChunks.push(cdHeader, nameBuf);
        }

        const cdBuffer = Buffer.concat(cdChunks);
        const cdOffset = offset;
        const cdSize = cdBuffer.length;
        const entryCount = this.entries.length;

        // End of Central Directory Record (22 bytes)
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);   // signature
        eocd.writeUInt16LE(0, 4);            // disk number
        eocd.writeUInt16LE(0, 6);            // disk with central directory
        eocd.writeUInt16LE(entryCount, 8);   // total entries on this disk
        eocd.writeUInt16LE(entryCount, 10);  // total entries in central directory
        eocd.writeUInt32LE(cdSize, 12);      // size of central directory
        eocd.writeUInt32LE(cdOffset, 16);    // offset of central directory
        eocd.writeUInt16LE(0, 20);           // comment length: 0

        return Buffer.concat([...localChunks, cdBuffer, eocd]);
    }
}

// 4. Assemble package files
const zip = new CleanZipWriter();

// Manifests
zip.addFile('[Content_Types].xml', contentTypesXml);
zip.addFile('extension.vsixmanifest', vsixManifestXml);

// Extension files
const copyList = [
    { src: 'dist/extension.js', dst: 'extension/dist/extension.js' },
    { src: 'dist/mcp-server.js', dst: 'extension/dist/mcp-server.js' },
    { src: 'package.json', dst: 'extension/package.json' },
    { src: 'package.nls.json', dst: 'extension/package.nls.json' },
    { src: 'package.nls.fr.json', dst: 'extension/package.nls.fr.json' },
    { src: 'language-configuration.json', dst: 'extension/language-configuration.json' },
    { src: 'syntaxes/vhdl.tmLanguage.json', dst: 'extension/syntaxes/vhdl.tmLanguage.json' },
    { src: 'fsm_designer_webview.html', dst: 'extension/fsm_designer_webview.html' },
    { src: 'schematic_webview.html', dst: 'extension/schematic_webview.html' },
    { src: 'waveform_webview.html', dst: 'extension/waveform_webview.html' },
    { src: 'README.md', dst: 'extension/README.md' },
    { src: 'README.fr.md', dst: 'extension/README.fr.md' },
    { src: 'LICENSE', dst: 'extension/LICENSE.txt' },
    { src: 'icon.png', dst: 'extension/icon.png' }
];

for (const item of copyList) {
    const srcPath = path.join(rootDir, item.src);
    if (fs.existsSync(srcPath)) {
        const fileContent = fs.readFileSync(srcPath);
        zip.addFile(item.dst, fileContent);
    } else {
        console.warn(`Warning: file not found: ${srcPath}`);
    }
}

// 5. Write .vsix file
const vsixBuffer = zip.toBuffer();
if (fs.existsSync(targetVsixPath)) {
    fs.unlinkSync(targetVsixPath);
}
fs.writeFileSync(targetVsixPath, vsixBuffer);

console.log(`\n✓ Successfully generated clean ${vsixName} (${Math.round(vsixBuffer.length / 1024)} kB) with 0 extra fields!`);
