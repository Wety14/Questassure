/**
 * @file package_vsix.js
 * @brief Script de création automatique d'un package .vsix pour Questassure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const vsixName = `questassure-vscode-${version}.vsix`;
const stagingDir = path.join(rootDir, '.vsix_staging');

console.log(`Building and packaging Questassure VHDL v${version} -> ${vsixName}...`);

// 1. Build bundles
console.log('Running npm run build...');
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

// 2. Prepare staging directory
if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
}
const extDir = path.join(stagingDir, 'extension');
fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'syntaxes'), { recursive: true });

// Copy files
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
    { src: 'LICENSE', dst: 'extension/LICENSE.txt' }
];

for (const item of copyList) {
    const srcPath = path.join(rootDir, item.src);
    const dstPath = path.join(stagingDir, item.dst);
    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, dstPath);
    } else {
        console.warn(`Warning: file not found: ${srcPath}`);
    }
}

// 3. Write [Content_Types].xml
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".html" ContentType="text/html"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`;
fs.writeFileSync(path.join(stagingDir, '[Content_Types].xml'), contentTypesXml, 'utf8');

// 4. Write extension.vsixmanifest
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
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
	</Assets>
</PackageManifest>`;
fs.writeFileSync(path.join(stagingDir, 'extension.vsixmanifest'), vsixManifestXml, 'utf8');

// 5. Create zip / vsix
const targetVsixPath = path.join(rootDir, vsixName);
if (fs.existsSync(targetVsixPath)) {
    fs.unlinkSync(targetVsixPath);
}

execSync(`zip -r "${targetVsixPath}" .`, { cwd: stagingDir, stdio: 'inherit' });

// 6. Cleanup
fs.rmSync(stagingDir, { recursive: true, force: true });

const stats = fs.statSync(targetVsixPath);
console.log(`\n✓ Successfully generated ${vsixName} (${Math.round(stats.size / 1024)} kB) !`);
