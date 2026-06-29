/**
 * @file ghdl.js
 * @brief Gestion de l'intégration avec le compilateur GHDL, le synthétiseur Yosys et netlistsvg.
 * Permet de compiler, simuler les bancs d'essai (testbenches), d'analyser la syntaxe
 * et de synthétiser des fichiers VHDL pour générer des schémas RTL au format SVG.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const { l } = require('./l10n');

/**
 * Motif regex d'analyse des diagnostics (erreurs/avertissements) renvoyés par GHDL.
 * Format attendu : fichier:ligne:colonne:message
 */
const DIAGNOSTIC_PATTERN = /^(.*?):(\d+):(\d+):(.*)$/;

/**
 * Détermine si une chaîne contient des caractères non-ASCII (accentués, spéciaux, etc.).
 *
 * @param {string} strVal - La chaîne à tester.
 * @returns {boolean} Vrai si des caractères non-ASCII sont présents.
 */
function hasNonAscii(strVal) {
    return /[^\x00-\x7F]/.test(strVal);
}

/**
 * Normalise et assainit un nom de fichier pour supprimer les accents et caractères spéciaux,
 * évitant ainsi des erreurs d'exécution d'outils CLI tiers comme GHDL.
 *
 * @param {string} name - Le nom de fichier brut.
 * @returns {string} Le nom assaini (ASCII-safe).
 */
function sanitizeFilename(name) {
    const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const safe = normalized.replace(/[^\w.\-]/g, "_");
    return safe || "file";
}

/**
 * Récupère le dossier temporaire du système s'il ne contient pas de caractères non-ASCII.
 * Si des caractères non-ASCII sont détectés (par exemple un nom d'utilisateur accentué),
 * renvoie un dossier de secours ASCII sûr (ex : C:\temp ou C:\questassure_tmp sur Windows).
 *
 * @returns {string} Le chemin absolu du dossier temporaire sûr.
 */
function getAsciiTempDir() {
    const defaultTemp = os.tmpdir();
    if (!hasNonAscii(defaultTemp)) {
        return defaultTemp;
    }
    if (process.platform === 'win32') {
        const fallbacks = ['C:\\temp', 'C:\\questassure_tmp'];
        for (const fb of fallbacks) {
            try {
                fs.mkdirSync(fb, { recursive: true });
                if (!hasNonAscii(fb)) {
                    const testFile = path.join(fb, 'questassure_write_test.txt');
                    fs.writeFileSync(testFile, 'test', 'utf8');
                    fs.unlinkSync(testFile);
                    return fb;
                }
            } catch (e) {
                // ignorer
            }
        }
    }
    return defaultTemp;
}

/**
 * Zone de transit (Staging Area) temporaire.
 * Copie les fichiers d'entrée VHDL contenant des caractères spéciaux ou non-ASCII
 * vers des chemins ASCII-safe dans un dossier temporaire afin de garantir que GHDL fonctionne correctement.
 */
class StagingArea {
    /**
     * @param {string[]} files - Liste des chemins de fichiers d'origine.
     */
    constructor(files) {
        this.tmp = fs.mkdtempSync(path.join(getAsciiTempDir(), 'questassure_'));
        this.workDir = path.join(this.tmp, 'ghdl_work');
        fs.mkdirSync(this.workDir);

        this.toStaged = new Map();
        this.toOrig = new Map();

        const usedNames = new Set();
        for (const orig of files) {
            const origR = path.resolve(orig);
            const ext = path.extname(origR);
            const stem = path.basename(origR, ext);
            const baseName = sanitizeFilename(stem);
            
            let candidate = `${baseName}${ext}`;
            let counter = 1;
            while (usedNames.has(candidate)) {
                candidate = `${baseName}_${counter}${ext}`;
                counter++;
            }
            usedNames.add(candidate);

            const staged = path.join(this.tmp, candidate);
            fs.copyFileSync(origR, staged);
            this.toStaged.set(origR, staged);
            this.toOrig.set(staged, origR);
        }
    }

    /**
     * Retourne le chemin du fichier temporaire copié (staged) pour un fichier d'origine.
     *
     * @param {string} orig - Chemin d'origine.
     * @returns {string} Chemin de transit.
     */
    pathFor(orig) {
        const origR = path.resolve(orig);
        return this.toStaged.get(origR) || origR;
    }

    /**
     * Retourne le chemin d'origine correspondant à un fichier de transit (staged).
     *
     * @param {string} staged - Chemin de transit.
     * @returns {string} Chemin d'origine.
     */
    originalFor(staged) {
        const stagedR = path.resolve(staged);
        return this.toOrig.get(stagedR) || stagedR;
    }

    /**
     * Re-mappe les chemins de fichiers dans les diagnostics GHDL temporaires vers leurs chemins d'origine.
     *
     * @param {Object[]} diags - Liste des diagnostics.
     * @returns {Object[]} Diagnostics traduits.
     */
    translateDiagnostics(diags) {
        return diags.map(d => {
            if (d.file) {
                const orig = this.originalFor(d.file);
                return { ...d, file: orig };
            }
            return d;
        });
    }

    /**
     * Supprime le dossier temporaire de transit et tout son contenu.
     */
    cleanup() {
        try {
            fs.rmSync(this.tmp, { recursive: true, force: true });
        } catch (e) {}
    }
}

/**
 * Analyse le texte brut des messages d'erreur/avertissement renvoyés par GHDL
 * et retourne un tableau d'objets de diagnostic structurés.
 *
 * @param {string} text - Le flux textuel de sortie d'erreurs (stderr) de GHDL.
 * @param {string|null} root - Le dossier racine pour résoudre les chemins relatifs.
 * @returns {Object[]} Liste des diagnostics analysés contenant le fichier, la ligne, la colonne, le message et la sévérité.
 */
function parseDiagnostics(text, root = null) {
    const diagnostics = [];
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const match = DIAGNOSTIC_PATTERN.exec(line);
        if (!match) {
            const severity = line.toLowerCase().includes('error') ? 'error' : 'info';
            diagnostics.push({ message: line, severity });
            continue;
        }

        const msg = match[4].trim();
        const severity = msg.toLowerCase().startsWith('warning') ? 'warning' : 'error';
        let filePath = match[1];
        if (root && !path.isAbsolute(filePath)) {
            filePath = path.resolve(root, filePath);
        } else {
            filePath = path.resolve(filePath);
        }

        diagnostics.push({
            file: filePath,
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            message: msg,
            severity
        });
    }
    return diagnostics;
}

/**
 * Vérifie si l'exécutable GHDL est disponible et accessible dans le PATH du système.
 *
 * @param {string} executable - Nom ou chemin de l'exécutable GHDL.
 * @returns {boolean} Vrai si GHDL est disponible.
 */
function isGhdlAvailable(executable = 'ghdl') {
    try {
        execFileSync(executable, ['--version'], { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Encapsule l'exécution asynchrone d'un fichier binaire CLI dans une Promise Javascript.
 * Comporte un mécanisme de secours spécifique à macOS pour ajuster MACOSX_DEPLOYMENT_TARGET
 * si des erreurs d'édition de liens (linker) surviennent lors de la compilation.
 *
 * @param {string} file - Chemin de l'exécutable.
 * @param {string[]} args - Tableau des arguments CLI.
 * @param {Object} options - Options d'exécution de child_process.
 * @returns {Promise<Object>} Promesse résolue avec le code de retour, stdout et stderr.
 */
function execFilePromise(file, args, options = {}) {
    return new Promise((resolve) => {
        const run = (retryCount = 0) => {
            const opt = { ...options };
            if (!opt.env) {
                opt.env = { ...process.env };
            }
            execFile(file, args, opt, (error, stdout, stderr) => {
                if (process.platform === 'darwin' && retryCount === 0 && stderr) {
                    const match = /built for newer 'macOS' version \(([\d.]+)\) than being linked/.exec(stderr);
                    if (match) {
                        const targetVersion = match[1];
                        process.env.MACOSX_DEPLOYMENT_TARGET = targetVersion;
                        opt.env.MACOSX_DEPLOYMENT_TARGET = targetVersion;
                        run(retryCount + 1);
                        return;
                    }
                }
                resolve({
                    error,
                    returncode: error ? (error.code || 1) : 0,
                    stdout,
                    stderr
                });
            });
        };
        run();
    });
}

/**
 * Compile séquentiellement une liste de fichiers sources VHDL vers un dossier de travail.
 *
 * @param {string} executable - Chemin de l'exécutable GHDL.
 * @param {string[]} sources - Liste ordonnée des chemins de fichiers à compiler.
 * @param {VhdlProject} project - Le projet de référence.
 * @param {string} workDir - Chemin du répertoire de travail GHDL cible.
 * @param {string} cwd - Répertoire de travail pour le processus d'exécution.
 * @param {StagingArea|null} stage - La zone de transit active, ou null.
 * @param {string|null} overrideLib - Force l'usage d'une bibliothèque spécifique pour tous les fichiers.
 * @returns {Promise<Object>} Résultats cumulés de la compilation.
 */
async function compileSourcesInto(executable, sources, project, workDir, cwd, stage, overrideLib = null) {
    let allStdout = '';
    let allStderr = '';
    const allDiagnostics = [];
    let lastCommand = [executable];
    let returncode = 0;

    for (const source of sources) {
        let fileLib;
        if (overrideLib !== null) {
            fileLib = overrideLib;
        } else {
            const relPath = project.relative_path(source);
            fileLib = project.file_libraries[relPath] || project.work_library;
        }
        const stagedSource = stage ? stage.pathFor(source) : source;

        const cmdArgs = [
            "-a",
            "--std=08",
            `--work=${fileLib}`,
            `--workdir=${workDir}`,
            stagedSource
        ];
        lastCommand = [executable, ...cmdArgs];

        const res = await execFilePromise(executable, cmdArgs, { cwd });
        allStdout += res.stdout;
        allStderr += res.stderr;

        const rawDiags = parseDiagnostics(res.stderr, cwd);
        const diags = stage ? stage.translateDiagnostics(rawDiags) : rawDiags;
        allDiagnostics.push(...diags);

        if (res.returncode !== 0) {
            returncode = res.returncode;
            break;
        }
    }

    return {
        command: lastCommand,
        returncode,
        stdout: allStdout,
        stderr: allStderr,
        diagnostics: allDiagnostics,
        ok: returncode === 0
    };
}

/**
 * Exécute un testbench VHDL (banc d'essai) via GHDL.
 * Effectue l'analyse et la compilation des dépendances, élabore et lance la simulation en générant
 * des fichiers de chronogrammes (GHW et VCD).
 *
 * @param {string} executable - Chemin de l'exécutable GHDL.
 * @param {VhdlProject} project - Projet de référence.
 * @param {string} entityName - Nom de l'entité de testbench à simuler.
 * @param {string} stopTime - Durée de simulation (ex: '1us').
 * @param {string} libName - Bibliothèque de travail VHDL.
 * @returns {Promise<Object>} Résultats de la simulation avec les chemins des fichiers d'ondes.
 */
async function runTestbench(executable, project, entityName, stopTime = "1us", libName = "work") {
    if (!isGhdlAvailable(executable)) {
        return {
            result: {
                command: [executable],
                returncode: 127,
                stdout: "",
                stderr: l('ghdl.err.not_available'),
                diagnostics: [{ message: l('ghdl.err.not_available'), severity: "error" }],
                ok: false
            },
            wavePath: null
        };
    }

    const sources = project.compilation_order();
    const simTmp = fs.mkdtempSync(path.join(getAsciiTempDir(), 'questassure_sim_'));
    const simWork = path.join(simTmp, 'ghdl_work');
    fs.mkdirSync(simWork);

    const needsStagingVal = hasNonAscii(simWork) || sources.some(p => hasNonAscii(p));
    const stage = needsStagingVal ? new StagingArea(sources) : null;

    try {
        const compileResult = await compileSourcesInto(executable, sources, project, simWork, simTmp, stage, libName);
        if (!compileResult.ok) {
            return { result: compileResult, wavePath: null };
        }

        // Phase 2 : Élaborer et lancer la simulation (Elab-run)
        const waveDir = path.resolve(project.root, 'build', 'questassure', 'waves');
        fs.mkdirSync(waveDir, { recursive: true });
        const wavePath = path.join(waveDir, `${entityName}.ghw`);
        const vcdPath = path.join(waveDir, `${entityName}.vcd`);

        let stagedWave = wavePath;
        if (hasNonAscii(wavePath)) {
            stagedWave = path.join(simTmp, `${entityName}.ghw`);
        }

        let stagedVcd = vcdPath;
        if (hasNonAscii(vcdPath)) {
            stagedVcd = path.join(simTmp, `${entityName}.vcd`);
        }

        const elabCommand = [
            "--elab-run",
            "--std=08",
            `--work=${libName}`,
            `--workdir=${simWork}`,
            entityName,
            `--wave=${stagedWave}`,
            `--vcd=${stagedVcd}`,
            "--vcd-enums",
            `--stop-time=${stopTime}`
        ];

        const res = await execFilePromise(executable, elabCommand, { cwd: simTmp });

        if (stagedWave !== wavePath && fs.existsSync(stagedWave)) {
            fs.copyFileSync(stagedWave, wavePath);
        }
        if (stagedVcd !== vcdPath && fs.existsSync(stagedVcd)) {
            fs.copyFileSync(stagedVcd, vcdPath);
        }

        const ok = res.returncode === 0;
        const result = {
            command: [executable, ...elabCommand],
            returncode: res.returncode,
            stdout: res.stdout,
            stderr: res.stderr,
            diagnostics: parseDiagnostics(res.stderr, project.root),
            ok
        };

        return {
            result,
            wavePath: fs.existsSync(wavePath) ? wavePath : null,
            vcdPath: fs.existsSync(vcdPath) ? vcdPath : null
        };
    } finally {
        if (stage) stage.cleanup();
        try {
            fs.rmSync(simTmp, { recursive: true, force: true });
        } catch (e) {}
    }
}

/**
 * Effectue une vérification syntaxique rapide sur un seul fichier VHDL.
 *
 * @param {string} executable - Chemin de l'exécutable GHDL.
 * @param {string} filePath - Chemin absolu du fichier VHDL.
 * @returns {Promise<Object>} Résultats contenant les diagnostics d'erreurs éventuels.
 */
async function checkSyntaxOnly(executable, filePath) {
    if (!isGhdlAvailable(executable)) {
        return {
            command: [executable],
            returncode: 127,
            stdout: "",
            stderr: l('ghdl.err.not_available'),
            diagnostics: [{ message: l('ghdl.err.not_available'), severity: "error" }],
            ok: false
        };
    }

    const fileResolved = path.resolve(filePath);
    const useStaging = hasNonAscii(fileResolved);
    const stage = useStaging ? new StagingArea([fileResolved]) : null;
    const stagedPath = stage ? stage.pathFor(fileResolved) : fileResolved;

    const cmdArgs = [
        "-s",
        "--std=08",
        stagedPath
    ];

    try {
        const res = await execFilePromise(executable, cmdArgs, { cwd: path.dirname(stagedPath) });
        const rawDiags = parseDiagnostics(res.stderr, stage ? stage.tmp : path.dirname(fileResolved));
        const diags = stage ? stage.translateDiagnostics(rawDiags) : rawDiags;

        return {
            command: [executable, ...cmdArgs],
            returncode: res.returncode,
            stdout: res.stdout,
            stderr: res.stderr,
            diagnostics: diags,
            ok: res.returncode === 0
        };
    } finally {
        if (stage) stage.cleanup();
    }
}

/**
 * Compile un fichier VHDL cible dans le cadre de son projet en s'assurant
 * que toutes ses dépendances sont préalablement compilées de façon ordonnée.
 *
 * @param {string} executable - Chemin de l'exécutable GHDL.
 * @param {VhdlProject} project - Le projet de référence.
 * @param {string} targetFile - Chemin absolu du fichier VHDL cible à analyser.
 * @returns {Promise<Object>} Les résultats cumulés de compilation du projet.
 */
async function analyzeFileInProject(executable, project, targetFile) {
    if (!isGhdlAvailable(executable)) {
        return {
            command: [executable],
            returncode: 127,
            stdout: "",
            stderr: l('ghdl.err.not_available'),
            diagnostics: [{ message: l('ghdl.err.not_available'), severity: "error" }],
            ok: false
        };
    }

    const targetResolved = path.resolve(targetFile);
    const orderedAll = project.compilation_order();
    const otherFiles = orderedAll.filter(p => path.resolve(p) !== targetResolved);
    const ordered = [...otherFiles, targetResolved];

    const workDir = path.join(project.root, 'build', 'questassure', 'ghdl');
    fs.mkdirSync(workDir, { recursive: true });

    const useStaging = hasNonAscii(workDir) || ordered.some(p => hasNonAscii(p));
    const stage = useStaging ? new StagingArea(ordered) : null;
    const activeWorkDir = stage ? stage.workDir : workDir;

    let allStdout = '';
    let allStderr = '';
    const allDiagnostics = [];
    let lastCommand = [executable];
    let returncode = 0;

    try {
        for (const source of ordered) {
            const relPath = project.relative_path(source);
            const fileLib = project.file_libraries[relPath] || project.work_library;
            const stagedSource = stage ? stage.pathFor(source) : source;
            const cwd = stage ? stage.workDir : project.root;

            const cmdArgs = [
                "-a",
                "--std=08",
                `--work=${fileLib}`,
                `--workdir=${activeWorkDir}`,
                stagedSource
            ];
            lastCommand = [executable, ...cmdArgs];

            const res = await execFilePromise(executable, cmdArgs, { cwd });
            allStdout += res.stdout;
            allStderr += res.stderr;

            const isTarget = path.resolve(source) === targetResolved;
            const rawDiags = parseDiagnostics(res.stderr, stage ? stage.tmp : project.root);
            const diags = stage ? stage.translateDiagnostics(rawDiags) : rawDiags;

            if (isTarget) {
                allDiagnostics.push(...diags);
                if (res.returncode !== 0) {
                    returncode = res.returncode;
                }
                break;
            } else {
                if (res.returncode !== 0) {
                    const depName = path.basename(source);
                    allDiagnostics.push({
                        message: l('project.err.dep_has_errors', depName, path.resolve(source)),
                        severity: "warning"
                    });
                }
            }
        }
    } finally {
        if (stage) stage.cleanup();
    }

    return {
        command: lastCommand,
        returncode,
        stdout: allStdout,
        stderr: allStderr,
        diagnostics: allDiagnostics,
        ok: returncode === 0
    };
}

/**
 * Vérifie si l'exécutable de synthèse Yosys est disponible dans le PATH du système.
 *
 * @returns {boolean} Vrai si Yosys est disponible.
 */
function isYosysAvailable() {
    try {
        execFileSync('yosys', ['-V'], { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

const BASE_SKIN_TEMPLATE = `<svg  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:s="https://github.com/nturley/netlistsvg"
  width="800" height="300">
  <s:properties>
    <s:layoutEngine
      org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers="35"
      org.eclipse.elk.spacing.nodeNode= "35"
      org.eclipse.elk.layered.layering.strategy= "LONGEST_PATH"
    />
    <s:low_priority_alias val="$dff" />
  </s:properties>
<style>
svg {
  stroke:#000;
  fill:none;
}
text {
  fill:#000;
  stroke:none;
  font-size:10px;
  font-weight: bold;
  font-family: "Courier New", monospace;
}
.nodelabel {
  text-anchor: middle;
}
.inputPortLabel {
  text-anchor: end;
}
.splitjoinBody {
  fill:#000;
}
</style>
  <g s:type="mux" transform="translate(50, 50)" s:width="20" s:height="40">
    <s:alias val="$pmux"/>
    <s:alias val="$mux"/>
    <s:alias val="$_MUX_"/>

    <path d="M0,0 L20,10 L20,30 L0,40 Z" class="$cell_id"/>
    <text x="4" y="13" style="fill:#000; stroke:none; font-size:8px; font-weight:normal; font-family:sans-serif;">0</text>
    <text x="4" y="33" style="fill:#000; stroke:none; font-size:8px; font-weight:normal; font-family:sans-serif;">1</text>

    <g s:x="0" s:y="10" s:pid="A"/>
    <g s:x="0" s:y="30" s:pid="B"/>
    <g s:x="10" s:y="35" s:pid="S"/>
    <g s:x="20" s:y="20" s:pid="Y"/>
  </g>

  <!-- and -->
  <g s:type="and" transform="translate(150,50)" s:width="30" s:height="25">
    <s:alias val="$and"/>
    <s:alias val="$logic_and"/>
    <s:alias val="$_AND_"/>

    <path d="M0,0 L0,25 L15,25 A15 12.5 0 0 0 15,0 Z" class="$cell_id"/>

    <g s:x="0" s:y="5" s:pid="A"/>
    <g s:x="0" s:y="20" s:pid="B"/>
    <g s:x="30" s:y="12.5" s:pid="Y"/>
  </g>
  <g s:type="nand" transform="translate(150,100)" s:width="30" s:height="25">
    <s:alias val="$nand"/>
    <s:alias val="$logic_nand"/>
    <s:alias val="$_NAND_"/>
    <s:alias val="$_ANDNOT_"/>

    <path d="M0,0 L0,25 L15,25 A15 12.5 0 0 0 15,0 Z" class="$cell_id"/>
    <circle cx="34" cy="12.5" r="3" class="$cell_id"/>

    <g s:x="0" s:y="5" s:pid="A"/>
    <g s:x="0" s:y="20" s:pid="B"/>
    <g s:x="36" s:y="12.5" s:pid="Y"/>
  </g>

  <!-- or -->
  <g s:type="or" transform="translate(250,50)" s:width="30" s:height="25">
    <s:alias val="$or"/>
    <s:alias val="$logic_or"/>
    <s:alias val="$_OR_"/>

    <path d="M0,25 L0,25 L15,25 A15 12.5 0 0 0 15,0 L0,0" class="$cell_id"/>
    <path d="M0,0 A30 25 0 0 1 0,25" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="30" s:y="12.5" s:pid="Y"/>
  </g>
  <g s:type="reduce_nor" transform="translate(250, 100)" s:width="33" s:height="25">
    <s:alias val="$nor"/>
    <s:alias val="$reduce_nor"/>
    <s:alias val="$_NOR_"/>
    <s:alias val="$_ORNOT_"/>

    <path d="M0,25 L0,25 L15,25 A15 12.5 0 0 0 15,0 L0,0" class="$cell_id"/>
    <path d="M0,0 A30 25 0 0 1 0,25" class="$cell_id"/>
    <circle cx="34" cy="12.5" r="3" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="36" s:y="12.5" s:pid="Y"/>
  </g>

  <!--xor -->
  <g s:type="reduce_xor" transform="translate(350, 50)" s:width="33" s:height="25">
    <s:alias val="$xor"/>
    <s:alias val="$reduce_xor"/>
    <s:alias val="$_XOR_"/>

    <path d="M3,0 A30 25 0 0 1 3,25 A30 25 0 0 0 33,12.5 A30 25 0 0 0 3,0" class="$cell_id"/>
    <path d="M0,0 A30 25 0 0 1 0,25" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="33" s:y="12.5" s:pid="Y"/>
  </g>
  <g s:type="reduce_nxor" transform="translate(350, 100)" s:width="33" s:height="25">
    <s:alias val="$xnor"/>
    <s:alias val="$reduce_xnor"/>
    <s:alias val="$_XNOR_"/>

    <path d="M3,0 A30 25 0 0 1 3,25 A30 25 0 0 0 33,12.5 A30 25 0 0 0 3,0" class="$cell_id"/>
    <path d="M0,0 A30 25 0 0 1 0,25" class="$cell_id"/>
    <circle cx="35" cy="12.5" r="3" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="38" s:y="12.5" s:pid="Y"/>
  </g>

  <!--buffer -->
  <g s:type="not" transform="translate(450,100)" s:width="30" s:height="20">
    <s:alias val="$_NOT_"/>
    <s:alias val="$not"/>
    <s:alias val="$logic_not"/>

    <path d="M0,0 L0,20 L20,10 Z" class="$cell_id"/>
    <circle cx="23" cy="10" r="3" class="$cell_id"/>

    <g s:x="0" s:y="10" s:pid="A"/>
    <g s:x="25" s:y="10" s:pid="Y"/>
  </g>

  <g s:type="add" transform="translate(50, 150)" s:width="25" s:height="25">
    <s:alias val="$add"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="12.5" y2="12.5" class="$cell_id"/>
    <line x1="12.5" x2="12.5" y1="7.5" y2="17.5" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>

  <g s:type="sub" transform="translate(150,150)" s:width="25" s:height="25">
    <s:alias val="$sub"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="12.5" y2="12.5" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>
  <g s:type="eq" transform="translate(250,150)" s:width="25" s:height="25">
    <s:alias val="$eq"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="10" y2="10" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="15" y2="15" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>

  <g s:type="dff" transform="translate(350,150)" s:width="30" s:height="40">
    <s:alias val="$dff"/>
    <s:alias val="$_DFF_"/>
    <s:alias val="$_DFF_P_"/>

    <rect width="30" height="40" x="0" y="0" class="$cell_id"/>
    <path d="M0,35 L5,30 L0,25" class="$cell_id"/>

    <g s:x="30" s:y="10" s:pid="Q"/>
    <g s:x="0" s:y="30" s:pid="CLK"/>
    <g s:x="0" s:y="30" s:pid="C"/>
    <g s:x="0" s:y="10" s:pid="D"/>
  </g>

  <g s:type="dffn" transform="translate(450,150)" s:width="30" s:height="40">
    <s:alias val="$_DFF_N_"/>

    <rect width="30" height="40" x="0" y="0" class="$cell_id"/>
    <path d="M0,35 L5,30 L0,25" class="$cell_id"/>
    <circle cx="-3" cy="30" r="3" class="$cell_id"/>

    <g s:x="30" s:y="10" s:pid="Q"/>
    <g s:x="-6" s:y="30" s:pid="CLK"/>
    <g s:x="-6" s:y="30" s:pid="C"/>
    <g s:x="0" s:y="10" s:pid="D"/>
  </g>

  <g s:type="lt" transform="translate(50,200)" s:width="25" s:height="25">
    <s:alias val="$lt"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="12.5" y2="7.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="12.5" y2="17.5" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>

  <g s:type="le" transform="translate(150,200)" s:width="25" s:height="25">
    <s:alias val="$le"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="12.5" y2="7.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="12.5" y2="17.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="15" y2="20" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>

  <g s:type="ge" transform="translate(250,200)" s:width="25" s:height="25">
    <s:alias val="$ge"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="7.5" y2="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="17.5" y2="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="20" y2="15" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>

  <g s:type="gt" transform="translate(350,200)" s:width="25" s:height="25">
    <s:alias val="$gt"/>

    <circle r="12.5" cx="12.5" cy="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="7.5" y2="12.5" class="$cell_id"/>
    <line x1="7.5" x2="17.5" y1="17.5" y2="12.5" class="$cell_id"/>

    <g s:x="3" s:y="5" s:pid="A"/>
    <g s:x="3" s:y="20" s:pid="B"/>
    <g s:x="25" s:y="12.5" s:pid="Y"/>
  </g>

  <g s:type="inputExt" transform="translate(50,250)" s:width="30" s:height="20">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">input</text>
    <s:alias val="$_inputExt_"/>
    <path d="M0,0 L0,20 L15,20 L30,10 L15,0 Z" class="$cell_id"/>
    <g s:x="28" s:y="10" s:pid="Y"/>
  </g>

  <g s:type="constant" transform="translate(150,250)" s:width="30" s:height="20">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">constant</text>

    <s:alias val="$_constant_"/>
    <rect width="30" height="20" class="$cell_id"/>

    <g s:x="30" s:y="10" s:pid="Y"/>
  </g>

  <g s:type="outputExt" transform="translate(250,250)" s:width="30" s:height="20">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">output</text>
    <s:alias val="$_outputExt_"/>
    <path d="M30,0 L30,20 L15,20 L0,10 L15,0 Z" class="$cell_id"/>

    <g s:x="0" s:y="10" s:pid="A"/>
  </g>

  <g s:type="split" transform="translate(350,250)" s:width="5" s:height="40">
    <rect width="5" height="40" class="splitjoinBody" s:generic="body"/>
    <s:alias val="$_split_"/>

    <g s:x="0" s:y="20" s:pid="in"/>
    <g transform="translate(5, 10)" s:x="4" s:y="10" s:pid="out0">
      <text x="5" y="-4">hi:lo</text>
    </g>
    <g transform="translate(5, 30)" s:x="4" s:y="30" s:pid="out1">
      <text x="5" y="-4">hi:lo</text>
    </g>
  </g>

  <g s:type="join" transform="translate(450,250)" s:width="4" s:height="40">
    <rect width="5" height="40" class="splitjoinBody" s:generic="body"/>
    <s:alias val="$_join_"/>
    <g s:x="5" s:y="20"  s:pid="out"/>
    <g transform="translate(0, 10)" s:x="0" s:y="10" s:pid="in0">
      <text x="-3" y="-4" class="inputPortLabel">hi:lo</text>
    </g>
    <g transform="translate(0, 30)" s:x="0" s:y="30" s:pid="in1">
      <text x="-3" y="-4" class="inputPortLabel">hi:lo</text>
    </g>
  </g>

  <g s:type="generic" transform="translate(550,250)" s:width="30" s:height="40">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">generic</text>
    <rect width="30" height="40" s:generic="body" class="$cell_id"/>

    <g transform="translate(30, 10)" s:x="30" s:y="10" s:pid="out0">
      <text x="5" y="-4" style="fill:#000; stroke:none" class="$cell_id">out0</text>
    </g>
    <g transform="translate(30, 30)" s:x="30" s:y="30" s:pid="out1">
      <text x="5" y="-4" style="fill:#000;stroke:none" class="$cell_id">out1</text>
    </g>
    <g transform="translate(0, 10)" s:x="0" s:y="10" s:pid="in0">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in0</text>
    </g>
    <g transform="translate(0, 30)" s:x="0" s:y="30" s:pid="in1">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in1</text>
    </g>
  </g>
</svg>
`;

const staticDffTemplates = `
  <!-- Questassure Custom DFF Templates -->
  <g s:type="dff_no_reset_no_en" transform="translate(0,0)" s:width="35" s:height="45">
    <s:alias val="$dff_no_reset_no_en"/>
    <rect width="35" height="45" x="0" y="0" class="$cell_id"/>
    <path d="M0,40 L5,35 L0,30" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="CLK"/>
  </g>

  <g s:type="dff_no_reset_en" transform="translate(0,0)" s:width="35" s:height="65">
    <s:alias val="$dff_no_reset_en"/>
    <rect width="35" height="65" x="0" y="0" class="$cell_id"/>
    <path d="M0,60 L5,55 L0,50" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="5" y="38" style="fill:#000; stroke:none; font-size:8px;">ENA</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="EN"/>
    <g s:x="0" s:y="55" s:pid="CLK"/>
  </g>

  <g s:type="dff_reset_bottom_low_no_en" transform="translate(0,0)" s:width="35" s:height="45">
    <s:alias val="$dff_reset_bottom_low_no_en"/>
    <rect width="35" height="45" x="0" y="0" class="$cell_id"/>
    <path d="M0,40 L5,35 L0,30" class="$cell_id"/>
    <circle cx="17.5" cy="48" r="3" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="40" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="CLK"/>
    <g s:x="17.5" s:y="51" s:pid="R"/>
  </g>

  <g s:type="dff_reset_bottom_low_en" transform="translate(0,0)" s:width="35" s:height="65">
    <s:alias val="$dff_reset_bottom_low_en"/>
    <rect width="35" height="65" x="0" y="0" class="$cell_id"/>
    <path d="M0,60 L5,55 L0,50" class="$cell_id"/>
    <circle cx="17.5" cy="68" r="3" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="5" y="38" style="fill:#000; stroke:none; font-size:8px;">ENA</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="60" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="EN"/>
    <g s:x="0" s:y="55" s:pid="CLK"/>
    <g s:x="17.5" s:y="71" s:pid="R"/>
  </g>

  <g s:type="dff_reset_bottom_high_no_en" transform="translate(0,0)" s:width="35" s:height="45">
    <s:alias val="$dff_reset_bottom_high_no_en"/>
    <rect width="35" height="45" x="0" y="0" class="$cell_id"/>
    <path d="M0,40 L5,35 L0,30" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="40" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="CLK"/>
    <g s:x="17.5" s:y="45" s:pid="R"/>
  </g>

  <g s:type="dff_reset_bottom_high_en" transform="translate(0,0)" s:width="35" s:height="65">
    <s:alias val="$dff_reset_bottom_high_en"/>
    <rect width="35" height="65" x="0" y="0" class="$cell_id"/>
    <path d="M0,60 L5,55 L0,50" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="5" y="38" style="fill:#000; stroke:none; font-size:8px;">ENA</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="60" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="EN"/>
    <g s:x="0" s:y="55" s:pid="CLK"/>
    <g s:x="17.5" s:y="65" s:pid="R"/>
  </g>

  <g s:type="dff_reset_top_low_no_en" transform="translate(0,0)" s:width="35" s:height="45">
    <s:alias val="$dff_reset_top_low_no_en"/>
    <rect width="35" height="45" x="0" y="0" class="$cell_id"/>
    <path d="M0,40 L5,35 L0,30" class="$cell_id"/>
    <circle cx="17.5" cy="-3" r="3" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="12" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="CLK"/>
    <g s:x="17.5" s:y="-6" s:pid="R"/>
  </g>

  <g s:type="dff_reset_top_low_en" transform="translate(0,0)" s:width="35" s:height="65">
    <s:alias val="$dff_reset_top_low_en"/>
    <rect width="35" height="65" x="0" y="0" class="$cell_id"/>
    <path d="M0,60 L5,55 L0,50" class="$cell_id"/>
    <circle cx="17.5" cy="-3" r="3" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="5" y="38" style="fill:#000; stroke:none; font-size:8px;">ENA</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="12" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="EN"/>
    <g s:x="0" s:y="55" s:pid="CLK"/>
    <g s:x="17.5" s:y="-6" s:pid="R"/>
  </g>

  <g s:type="dff_reset_top_high_no_en" transform="translate(0,0)" s:width="35" s:height="45">
    <s:alias val="$dff_reset_top_high_no_en"/>
    <rect width="35" height="45" x="0" y="0" class="$cell_id"/>
    <path d="M0,40 L5,35 L0,30" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="12" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="CLK"/>
    <g s:x="17.5" s:y="0" s:pid="R"/>
  </g>

  <g s:type="dff_reset_top_high_en" transform="translate(0,0)" s:width="35" s:height="65">
    <s:alias val="$dff_reset_top_high_en"/>
    <rect width="35" height="65" x="0" y="0" class="$cell_id"/>
    <path d="M0,60 L5,55 L0,50" class="$cell_id"/>
    <text x="5" y="18" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="5" y="38" style="fill:#000; stroke:none; font-size:8px;">ENA</text>
    <text x="25" y="18" style="fill:#000; stroke:none; font-size:10px;">Q</text>
    <text x="17.5" y="12" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">R</text>
    <g s:x="0" s:y="15" s:pid="D"/>
    <g s:x="35" s:y="15" s:pid="Q"/>
    <g s:x="0" s:y="35" s:pid="EN"/>
    <g s:x="0" s:y="55" s:pid="CLK"/>
    <g s:x="17.5" s:y="0" s:pid="R"/>
  </g>
`;

/**
 * Génère le schéma RTL vectoriel SVG d'une entité VHDL par synthèse logique.
 * Utilise GHDL pour synthétiser en Verilog, puis Yosys pour générer une netlist JSON,
 * optimise cette netlist (multiplexeurs, cascades de portes logiques) et enfin
 * netlistsvg pour faire le rendu visuel au format SVG.
 *
 * @param {string} executable - Chemin de l'exécutable GHDL.
 * @param {VhdlProject|null} project - Projet de référence, ou null.
 * @param {string} targetFile - Fichier cible contenant l'entité.
 * @param {string} entityName - Nom de l'entité à synthétiser.
 * @returns {Promise<Object>} Objet contenant le code source SVG et la netlist JSON.
 * @throws {Error} Si GHDL, Yosys ou netlistsvg échoue.
 */
async function generateRtlSvg(executable, project, targetFile, entityName) {
    if (!isGhdlAvailable(executable)) {
        throw new Error(l('ghdl.err.not_available'));
    }
    if (!isYosysAvailable()) {
        throw new Error(l('yosys.err.not_available'));
    }

    const simTmp = fs.mkdtempSync(path.join(getAsciiTempDir(), 'questassure_rtl_'));
    const workDir = path.join(simTmp, 'ghdl_work');
    fs.mkdirSync(workDir);

    const targetResolved = path.resolve(targetFile);
    const sources = project ? project.compilation_order() : [targetResolved];
    
    const needsStagingVal = hasNonAscii(simTmp) || sources.some(p => hasNonAscii(p));
    const stage = needsStagingVal ? new StagingArea(sources) : null;

    try {
        for (const source of sources) {
            const fileLib = project ? (project.file_libraries[project.relative_path(source)] || project.work_library) : 'work';
            const stagedSource = stage ? stage.pathFor(source) : source;

            const cmdArgs = [
                "-a",
                "--std=08",
                `--work=${fileLib}`,
                `--workdir=${workDir}`,
                stagedSource
            ];
            const res = await execFilePromise(executable, cmdArgs, { cwd: simTmp });
            if (res.returncode !== 0) {
                throw new Error(l('ghdl.err.analysis_failed', path.basename(source), res.stderr || res.error.message));
            }
        }

        const relPath = project ? project.relative_path(targetResolved) : null;
        const fileLib = (project && relPath && project.file_libraries[relPath]) || 'work';
        const topUnitName = `${fileLib}.${entityName}`;

        const verilogFile = path.join(simTmp, `${entityName}_synth.v`);
        const synthArgs = [
            "--synth",
            "--std=08",
            `--workdir=${workDir}`,
            `-P${workDir}`,
            "--out=verilog",
            topUnitName
        ];

        const synthRes = await execFilePromise(executable, synthArgs, { cwd: simTmp });
        if (synthRes.returncode !== 0) {
            throw new Error(l('ghdl.err.synthesis_failed', synthRes.stderr || synthRes.error.message));
        }
        
        fs.writeFileSync(verilogFile, synthRes.stdout, 'utf8');

        const jsonFile = path.join(simTmp, `${entityName}_synth.json`);
        const yosysCommand = `read_verilog "${verilogFile}"; prep -top ${entityName}; write_json -compat-int "${jsonFile}"`;
        
        const yosysRes = await execFilePromise('yosys', ['-p', yosysCommand], { cwd: simTmp });
        if (yosysRes.returncode !== 0) {
            throw new Error(l('yosys.err.synthesis_failed', yosysRes.stderr || yosysRes.error.message));
        }

        // --- PREPROCESS JSON AND GENERATE CUSTOM SKIN ---
        const jsonContent = fs.readFileSync(jsonFile, 'utf8');
        const netlistObj = JSON.parse(jsonContent);

        for (const modName in netlistObj.modules) {
            const module = netlistObj.modules[modName];

            // 1. Simplify 1-bit multiplexers where Y = S (meaning A = '0', B = '1')
            let simplifiedMux = true;
            while (simplifiedMux) {
                simplifiedMux = false;
                for (const cellName in module.cells) {
                    const cell = module.cells[cellName];
                    if (cell.type === "$mux") {
                        const connA = cell.connections.A;
                        const connB = cell.connections.B;
                        const connS = cell.connections.S;
                        const connY = cell.connections.Y;
                        
                        if (connA && connA.length === 1 && String(connA[0]) === "0" &&
                            connB && connB.length === 1 && String(connB[0]) === "1" &&
                            connS && connS.length === 1 &&
                            connY && connY.length === 1) {
                            
                            const outBit = connY[0];
                            const selBit = connS[0];
                            
                            // Replace outBit with selBit everywhere in cells
                            for (const cName in module.cells) {
                                const otherCell = module.cells[cName];
                                for (const port in otherCell.connections) {
                                    const conn = otherCell.connections[port];
                                    for (let i = 0; i < conn.length; i++) {
                                        if (conn[i] === outBit) {
                                            conn[i] = selBit;
                                        }
                                    }
                                }
                            }
                            
                            // Replace in module ports
                            for (const portName in module.ports) {
                                const port = module.ports[portName];
                                for (let i = 0; i < port.bits.length; i++) {
                                    if (port.bits[i] === outBit) {
                                        port.bits[i] = selBit;
                                    }
                                }
                            }
                            
                            // Replace in module netnames
                            for (const netName in module.netnames) {
                                const net = module.netnames[netName];
                                for (let i = 0; i < net.bits.length; i++) {
                                    if (net.bits[i] === outBit) {
                                        net.bits[i] = selBit;
                                    }
                                }
                            }
                            
                            delete module.cells[cellName];
                            simplifiedMux = true;
                            break;
                        }
                    }
                }
            }

            // 2. Group AND/OR gate cascades
            const isAndType = (t) => ["$and", "$logic_and", "$_AND_"].includes(t);
            const isOrType = (t) => ["$or", "$logic_or", "$_OR_"].includes(t);
            const getFamily = (t) => isAndType(t) ? "and" : (isOrType(t) ? "or" : null);

            let gateChanged = true;
            while (gateChanged) {
                gateChanged = false;

                // Rebuild bit driver map
                const bitDriverCell = {};
                for (const cellName in module.cells) {
                    const cell = module.cells[cellName];
                    for (const port in cell.connections) {
                        if (cell.port_directions && cell.port_directions[port] === "output") {
                            for (const bit of cell.connections[port]) {
                                if (typeof bit === "number") {
                                    bitDriverCell[bit] = cellName;
                                }
                            }
                        }
                    }
                }

                // Rebuild bit reader count map
                const bitReaderCount = {};
                for (const cellName in module.cells) {
                    const cell = module.cells[cellName];
                    for (const port in cell.connections) {
                        if (cell.port_directions && cell.port_directions[port] === "input") {
                            for (const bit of cell.connections[port]) {
                                if (typeof bit === "number") {
                                    bitReaderCount[bit] = (bitReaderCount[bit] || 0) + 1;
                                }
                            }
                        }
                    }
                }
                for (const portName in module.ports) {
                    const port = module.ports[portName];
                    if (port.direction === "output") {
                        for (const bit of port.bits) {
                            if (typeof bit === "number") {
                                bitReaderCount[bit] = (bitReaderCount[bit] || 0) + 1;
                            }
                        }
                    }
                }

                // Find roots of AND/OR gate cascades
                let rootCellName = null;
                for (const cellName in module.cells) {
                    const cell = module.cells[cellName];
                    const family = getFamily(cell.type);
                    if (family) {
                        const outBits = cell.connections.Y;
                        if (outBits && outBits.length === 1) {
                            const outBit = outBits[0];
                            let readBySameFamily = false;
                            for (const otherCellName in module.cells) {
                                if (otherCellName === cellName) continue;
                                const otherCell = module.cells[otherCellName];
                                if (getFamily(otherCell.type) === family) {
                                    for (const port in otherCell.connections) {
                                        if (otherCell.port_directions && otherCell.port_directions[port] === "input") {
                                            if (otherCell.connections[port].includes(outBit)) {
                                                readBySameFamily = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                                if (readBySameFamily) break;
                            }
                            if (!readBySameFamily) {
                                let hasSubGate = false;
                                for (const port of ["A", "B"]) {
                                    const conn = cell.connections[port];
                                    if (conn) {
                                        for (const bit of conn) {
                                            const drvName = bitDriverCell[bit];
                                            const drv = drvName ? module.cells[drvName] : null;
                                            if (drv && getFamily(drv.type) === family && bitReaderCount[bit] === 1) {
                                                hasSubGate = true;
                                                break;
                                            }
                                        }
                                    }
                                    if (hasSubGate) break;
                                }
                                if (hasSubGate) {
                                    rootCellName = cellName;
                                    break;
                                }
                            }
                        }
                    }
                }

                if (rootCellName) {
                    const rootCell = module.cells[rootCellName];
                    const family = getFamily(rootCell.type);
                    const cellsToDelete = new Set();
                    
                    const gatherInputs = (cName) => {
                        const cell = module.cells[cName];
                        const inputs = [];
                        for (const port of ["A", "B"]) {
                            const conn = cell.connections[port];
                            if (conn) {
                                for (const bit of conn) {
                                    const drvName = bitDriverCell[bit];
                                    const drv = drvName ? module.cells[drvName] : null;
                                    if (drv && getFamily(drv.type) === family && bitReaderCount[bit] === 1) {
                                        cellsToDelete.add(drvName);
                                        inputs.push(...gatherInputs(drvName));
                                    } else {
                                        inputs.push(bit);
                                    }
                                }
                            }
                        }
                        return inputs;
                    };

                    const gathered = gatherInputs(rootCellName);
                    if (gathered.length > 2) {
                        cellsToDelete.add(rootCellName);
                        
                        const cleanRootName = rootCellName.replace(/[^a-zA-Z0-9_]/g, '_');
                        const newCellName = `custom_${family}_${cleanRootName}`;
                        const customGateType = `custom_${family}_${gathered.length}_${newCellName}`;
                        
                        const newCell = {
                            hide_name: 1,
                            type: `$${customGateType}`,
                            port_directions: {
                                Y: "output"
                            },
                            connections: {
                                Y: rootCell.connections.Y
                            }
                        };
                        for (let i = 0; i < gathered.length; i++) {
                            newCell.port_directions["I" + i] = "input";
                            newCell.connections["I" + i] = [gathered[i]];
                        }
                        
                        for (const name of cellsToDelete) {
                            delete module.cells[name];
                        }
                        
                        module.cells[newCellName] = newCell;
                        gateChanged = true;
                    }
                }
            }
        }

        // Group multiplexer cascades into N-input multiplexer cells
        for (const modName in netlistObj.modules) {
            const module = netlistObj.modules[modName];
            const ignoredStarts = new Set();
            let changed = true;
            while (changed) {
                changed = false;
                
                // Rebuild bit driver map
                const bitDriverCell = {};
                for (const cellName in module.cells) {
                    const cell = module.cells[cellName];
                    for (const port in cell.connections) {
                        if (cell.port_directions && cell.port_directions[port] === "output") {
                            for (const bit of cell.connections[port]) {
                                if (typeof bit === "number") {
                                    bitDriverCell[bit] = cellName;
                                }
                            }
                        }
                    }
                }

                // Find all mux cells
                const muxCells = [];
                for (const cellName in module.cells) {
                    if (module.cells[cellName].type === "$mux") {
                        muxCells.push(cellName);
                    }
                }

                // Identify the A inputs of all mux cells
                const muxAInputs = new Set();
                for (const cellName of muxCells) {
                    const cell = module.cells[cellName];
                    if (cell.connections.A) {
                        for (const bit of cell.connections.A) {
                            if (typeof bit === "number") {
                                muxAInputs.add(bit);
                            }
                        }
                    }
                }

                let startMuxName = null;
                for (const cellName of muxCells) {
                    if (ignoredStarts.has(cellName)) continue;
                    const cell = module.cells[cellName];
                    const hasYOut = cell.connections.Y && cell.connections.Y.some(bit => muxAInputs.has(bit));
                    if (!hasYOut) {
                        startMuxName = cellName;
                        break;
                    }
                }

                if (!startMuxName) {
                    break;
                }

                // Trace the chain backwards through input A
                const chain = [];
                let currName = startMuxName;
                while (currName) {
                    chain.push(currName);
                    const cell = module.cells[currName];
                    const A_bits = cell.connections.A;
                    if (A_bits && A_bits.length > 0 && typeof A_bits[0] === "number") {
                        const nextCellName = bitDriverCell[A_bits[0]];
                        if (nextCellName && module.cells[nextCellName] && module.cells[nextCellName].type === "$mux") {
                            currName = nextCellName;
                        } else {
                            currName = null;
                        }
                    } else {
                        currName = null;
                    }
                }

                let grouped = false;
                if (chain.length >= 2) {
                    // Verify common selector and gather select drivers
                    let commonCtrl = null;
                    let commonCtrlStr = null;
                    let valid = true;
                    const selectDrivers = [];

                    for (const muxName of chain) {
                        const cell = module.cells[muxName];
                        const S_bit = cell.connections.S && cell.connections.S[0];
                        if (typeof S_bit !== "number") {
                            valid = false;
                            break;
                        }
                        const driverName = bitDriverCell[S_bit];
                        if (!driverName) {
                            valid = false;
                            break;
                        }
                        const driver = module.cells[driverName];
                        if (driver.type !== "$eq" && driver.type !== "$logic_not") {
                            valid = false;
                            break;
                        }
                        const ctrl = driver.connections.A;
                        const ctrlStr = JSON.stringify(ctrl);
                        if (commonCtrlStr === null) {
                            commonCtrl = ctrl;
                            commonCtrlStr = ctrlStr;
                        } else if (commonCtrlStr !== ctrlStr) {
                            valid = false;
                            break;
                        }
                        selectDrivers.push(driverName);
                    }

                    if (valid && commonCtrl && commonCtrl.length > 0) {
                        const W_ctrl = commonCtrl.length;
                        const N = Math.pow(2, W_ctrl);

                        if (N <= 32) {
                            const width_Y = module.cells[startMuxName].connections.Y.length;
                            const inputs = {};

                            // Perform bit-level simulation/evaluation for each input combination
                            for (let v = 0; v < N; v++) {
                                const env = {};
                                for (let j = 0; j < W_ctrl; j++) {
                                    env[commonCtrl[j]] = ((v >> j) & 1) ? "1" : "0";
                                }

                                const memo = {};
                                function evalBit(bit) {
                                    if (bit === "0" || bit === "1") return bit;
                                    if (env[bit] !== undefined) return env[bit];
                                    if (memo[bit] !== undefined) return memo[bit];

                                    const drvName = bitDriverCell[bit];
                                    if (!drvName || !module.cells[drvName]) {
                                        return "0";
                                    }
                                    const drv = module.cells[drvName];
                                    if (drv.type === "$logic_not") {
                                        const A_port = drv.connections.A;
                                        let allZero = true;
                                        for (const b of A_port) {
                                            if (evalBit(b) !== "0") {
                                                allZero = false;
                                                break;
                                            }
                                        }
                                        memo[bit] = allZero ? "1" : "0";
                                        return memo[bit];
                                    } else if (drv.type === "$eq") {
                                        const A_port = drv.connections.A;
                                        const B_port = drv.connections.B;
                                        let eq = true;
                                        const len = Math.max(A_port.length, B_port.length);
                                        for (let idx = 0; idx < len; idx++) {
                                            const valA = idx < A_port.length ? evalBit(A_port[idx]) : "0";
                                            const valB = idx < B_port.length ? evalBit(B_port[idx]) : "0";
                                            if (valA !== valB) {
                                                eq = false;
                                                break;
                                            }
                                        }
                                        memo[bit] = eq ? "1" : "0";
                                        return memo[bit];
                                    } else if (drv.type === "$mux") {
                                        const S_port = drv.connections.S[0];
                                        const valS = evalBit(S_port);
                                        const idx = drv.connections.Y.indexOf(bit);
                                        if (valS === "1") {
                                            memo[bit] = evalBit(drv.connections.B[idx]);
                                        } else {
                                            memo[bit] = evalBit(drv.connections.A[idx]);
                                        }
                                        return memo[bit];
                                    }
                                    return "0";
                                }

                                const outVal = [];
                                const startMux = module.cells[startMuxName];
                                for (let k = 0; k < width_Y; k++) {
                                    outVal.push(evalBit(startMux.connections.Y[k]));
                                }
                                inputs["I" + v] = outVal;
                            }

                            // Create the custom multi-input multiplexer cell
                            const cleanStartMuxName = startMuxName.replace(/[^a-zA-Z0-9_]/g, '_');
                            const newCellName = `custom_mux_${cleanStartMuxName}`;
                            const customMuxType = `custom_mux_${N}_w${width_Y}_${newCellName}`;
                            const newCell = {
                                hide_name: 1,
                                type: `$${customMuxType}`,
                                parameters: {
                                    WIDTH: width_Y,
                                    S_WIDTH: W_ctrl
                                },
                                port_directions: {
                                    S: "input",
                                    Y: "output"
                                },
                                connections: {
                                    S: commonCtrl,
                                    Y: module.cells[startMuxName].connections.Y
                                }
                            };

                            for (let v = 0; v < N; v++) {
                                newCell.port_directions["I" + v] = "input";
                                newCell.connections["I" + v] = inputs["I" + v];
                            }

                            module.cells[newCellName] = newCell;

                            // Remove old cells
                            for (const name of chain) {
                                delete module.cells[name];
                            }
                            for (const name of selectDrivers) {
                                delete module.cells[name];
                            }

                            grouped = true;
                            changed = true;
                        }
                    }
                }

                if (!grouped) {
                    ignoredStarts.add(startMuxName);
                }
            }
        }

        const customSkinTemplates = [];
        const addedConstTemplates = new Set();
        const addedInstTemplates = new Set();

        function escapeXml(unsafe) {
            if (typeof unsafe !== 'string') return '';
            return unsafe.replace(/[<>&'"]/g, function (c) {
                switch (c) {
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '&': return '&amp;';
                    case '\'': return '&apos;';
                    case '"': return '&quot;';
                }
            });
        }

        const opSymbols = {
            '$add': '+',
            '$sub': '-',
            '$eq': '=',
            '$ne': '!=',
            '$lt': '<',
            '$le': '<=',
            '$ge': '>=',
            '$gt': '>'
        };

        function parseParamValue(p) {
            if (typeof p === 'number') return p;
            if (typeof p === 'string') {
                if (p.includes('x') || p.includes('z')) return 0;
                return parseInt(p, 2) || parseInt(p, 10) || 0;
            }
            return 0;
        }

        function findNetName(mod, bitIndex) {
            for (const portName in mod.ports) {
                if (mod.ports[portName].bits.includes(bitIndex)) {
                    return portName;
                }
            }
            let backupName = null;
            for (const netName in mod.netnames) {
                const net = mod.netnames[netName];
                if (net.bits.includes(bitIndex)) {
                    if (net.hide_name === 0) {
                        return netName;
                    }
                    backupName = netName;
                }
            }
            return backupName || 'R';
        }

        function getResetValueString(paramVal, width) {
            if (paramVal === undefined) return '';
            let val = 0;
            if (typeof paramVal === 'number') {
                val = paramVal;
            } else if (typeof paramVal === 'string') {
                if (paramVal.includes('x') || paramVal.includes('z')) {
                    const clean = paramVal.replace(/[xz]/g, '0');
                    val = parseInt(clean, 2) || 0;
                } else {
                    val = parseInt(paramVal, 2) || parseInt(paramVal, 10) || 0;
                }
            }
            return val.toString(2).padStart(width, '0');
        }


        for (const modName in netlistObj.modules) {
            const mod = netlistObj.modules[modName];
            for (const cellName in mod.cells) {
                const cell = mod.cells[cellName];
                const type = cell.type;

                // 1. Const folding into adder/comparator
                if (opSymbols[type] !== undefined) {
                    let constPort = null;
                    if (cell.connections.B && cell.connections.B.every(x => typeof x === 'string')) {
                        constPort = 'B';
                    } else if (cell.connections.A && cell.connections.A.every(x => typeof x === 'string')) {
                        constPort = 'A';
                    }

                    if (constPort) {
                        const bits = cell.connections[constPort];
                        let val = 0;
                        let valid = true;
                        for (let i = 0; i < bits.length; i++) {
                            if (bits[i] === '1') {
                                val += Math.pow(2, i);
                            } else if (bits[i] !== '0') {
                                valid = false;
                                break;
                            }
                        }
                        if (valid) {
                            // Modify cell in json
                            delete cell.connections[constPort];
                            if (cell.port_directions) {
                                delete cell.port_directions[constPort];
                            }
                            const opSym = opSymbols[type];
                            const newTypeName = `${type.substring(1)}_const_${val}`;
                            cell.type = `$${newTypeName}`;

                            // Generate and add skin template
                            if (!addedConstTemplates.has(newTypeName)) {
                                addedConstTemplates.add(newTypeName);
                                const template = `
  <g s:type="${newTypeName}" transform="translate(0,0)" s:width="30" s:height="30">
    <s:alias val="$${newTypeName}"/>
    <circle r="15" cx="15" cy="15" class="$cell_id"/>
    <text x="15" y="18" class="nodelabel $cell_id" style="fill:#000; stroke:none; font-size:10px; font-weight:bold; font-family:Courier New, monospace; text-anchor:middle;">${escapeXml(opSym)}${val}</text>
    <g s:x="0" s:y="15" s:pid="A"/>
    <g s:x="0" s:y="15" s:pid="B"/>
    <g s:x="30" s:y="15" s:pid="Y"/>
  </g>`;
                                customSkinTemplates.push(template);
                            }
                        }
                    }
                }

                // 2. DFF/DFFE Flip-flop customizing
                const isDff = type === '$dff' || type === '$dffe' || type === '$adff' || type === '$sdff' || type === '$adffe' || type === '$sdffe' || type.toUpperCase().startsWith('$_DFF');
                if (isDff) {
                    let hasEn = false;
                    let hasReset = false;
                    let resetPolarity = 0; // default active-low
                    let resetValue = 0; // default reset to 0
                    
                    const width = (cell.parameters && cell.parameters.WIDTH !== undefined) ? parseParamValue(cell.parameters.WIDTH) : 1;

                    const connKeys = Object.keys(cell.connections);
                    if (connKeys.some(k => ['EN', 'ENA', 'E'].includes(k))) {
                        hasEn = true;
                    }
                    if (connKeys.some(k => ['ARST', 'SRST', 'RST', 'RESET', 'R'].includes(k))) {
                        hasReset = true;
                    }

                    let rawResetValParam = undefined;
                    if (cell.parameters) {
                        if (cell.parameters.ARST_VALUE !== undefined) {
                            rawResetValParam = cell.parameters.ARST_VALUE;
                            hasReset = true;
                        }
                        if (cell.parameters.ARST_POLARITY !== undefined) {
                            resetPolarity = parseParamValue(cell.parameters.ARST_POLARITY);
                            hasReset = true;
                        }
                        if (cell.parameters.SRST_VALUE !== undefined) {
                            rawResetValParam = cell.parameters.SRST_VALUE;
                            hasReset = true;
                        }
                        if (cell.parameters.SRST_POLARITY !== undefined) {
                            resetPolarity = parseParamValue(cell.parameters.SRST_POLARITY);
                            hasReset = true;
                        }
                    }

                    const typeUpper = type.toUpperCase();
                    if (typeUpper.startsWith('$_DFF')) {
                        if (typeUpper.includes('_E_') || typeUpper.includes('DFFE')) {
                            hasEn = true;
                        }
                        const parts = typeUpper.split('_');
                        const suffix = parts[parts.length - 2] || parts[parts.length - 1] || "";
                        if (suffix.length >= 3) {
                            if (suffix.startsWith('PP0') || suffix.startsWith('PN0') || suffix.startsWith('NP0') || suffix.startsWith('NN0')) {
                                resetPolarity = suffix[1] === 'P' ? 1 : 0;
                                resetValue = 0;
                                hasReset = true;
                            } else if (suffix.startsWith('PP1') || suffix.startsWith('PN1') || suffix.startsWith('NP1') || suffix.startsWith('NN1')) {
                                resetPolarity = suffix[1] === 'P' ? 1 : 0;
                                resetValue = 1;
                                hasReset = true;
                            } else if (suffix.includes('P0') || suffix.includes('N0')) {
                                const idx = suffix.indexOf('0');
                                resetPolarity = suffix[idx - 1] === 'P' ? 1 : 0;
                                resetValue = 0;
                                hasReset = true;
                            } else if (suffix.includes('P1') || suffix.includes('N1')) {
                                const idx = suffix.indexOf('1');
                                resetPolarity = suffix[idx - 1] === 'P' ? 1 : 0;
                                resetValue = 1;
                                hasReset = true;
                            }
                        }
                    }

                    let resetValStr = '';
                    if (hasReset) {
                        if (rawResetValParam !== undefined) {
                            resetValStr = getResetValueString(rawResetValParam, width);
                        } else {
                            resetValStr = resetValue.toString(2).padStart(width, '0');
                        }
                    }

                    // Find connected reset net name if present
                    let originalResetPort = null;
                    for (const key in cell.connections) {
                        if (['ARST', 'SRST', 'RST', 'RESET', 'R'].includes(key)) {
                            originalResetPort = key;
                            break;
                        }
                    }

                    let resetNetName = 'R';
                    if (originalResetPort) {
                        const conn = cell.connections[originalResetPort];
                        if (Array.isArray(conn) && conn.length > 0) {
                            const bitIndex = conn[0];
                            if (typeof bitIndex === 'number') {
                                resetNetName = findNetName(mod, bitIndex);
                            }
                        }
                    }

                    // Map to unified template type specific to this cell name (to support custom labels/width/slashes)
                    const templateName = `dff_${cellName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    cell.type = `$${templateName}`;

                    // Unify port connection names
                    const newConnections = {};
                    const newPortDirs = {};
                    for (const port in cell.connections) {
                        let targetPort = port;
                        if (['CLK', 'C'].includes(port)) targetPort = 'CLK';
                        else if (['ARST', 'SRST', 'RST', 'RESET', 'R'].includes(port)) targetPort = 'R';
                        else if (['EN', 'ENA', 'E'].includes(port)) targetPort = 'EN';
                        newConnections[targetPort] = cell.connections[port];
                        if (cell.port_directions && cell.port_directions[port]) {
                            newPortDirs[targetPort] = cell.port_directions[port];
                        }
                    }
                    cell.connections = newConnections;
                    if (cell.port_directions) {
                        cell.port_directions = newPortDirs;
                    }

                    // Generate dynamic SVG template for this cell
                    const W_rect = 55;
                    const H = hasEn ? 90 : 70;
                    const clkY = hasEn ? 70 : 45;
                    
                    let template = `
  <g s:type="${templateName}" transform="translate(0,0)" s:width="${W_rect}" s:height="${H}">
    <s:alias val="$${templateName}"/>
    <rect width="${W_rect}" height="${H}" x="0" y="0" class="$cell_id"/>
    <path d="M0,${clkY + 5} L5,${clkY} L0,${clkY - 5}" class="$cell_id"/>
    <text x="5" y="24" style="fill:#000; stroke:none; font-size:10px;">D</text>
    <text x="${W_rect - 12}" y="24" style="fill:#000; stroke:none; font-size:10px;">Q</text>
                    `;
                    
                    if (hasEn) {
                        template += `    <text x="5" y="48" style="fill:#000; stroke:none; font-size:10px;">ENA</text>\n`;
                    }
                    
                    // Draw stub lines
                    template += `    <line x1="-15" x2="0" y1="20" y2="20" class="$cell_id"/>\n`;
                    template += `    <line x1="${W_rect}" x2="${W_rect + 15}" y1="20" y2="20" class="$cell_id"/>\n`;
                    if (hasEn) {
                        template += `    <line x1="-15" x2="0" y1="45" y2="45" class="$cell_id"/>\n`;
                        template += `    <line x1="-15" x2="0" y1="70" y2="70" class="$cell_id"/>\n`;
                    } else {
                        template += `    <line x1="-15" x2="0" y1="45" y2="45" class="$cell_id"/>\n`;
                    }
                    
                    // Slashes and Width text
                    if (width > 1) {
                        template += `    <line x1="-10" y1="24" x2="-4" y2="16" class="$cell_id"/>\n`;
                        template += `    <text x="-7" y="33" style="fill:#000; stroke:none; font-size:8px; text-anchor:middle;">${width}</text>\n`;
                        template += `    <line x1="${W_rect + 4}" y1="24" x2="${W_rect + 10}" y2="16" class="$cell_id"/>\n`;
                        template += `    <text x="${W_rect + 7}" y="33" style="fill:#000; stroke:none; font-size:8px; text-anchor:middle;">${width}</text>\n`;
                    }
                    
                    // Reset pin and labels
                    if (hasReset) {
                        if (resetPolarity === 0) {
                            // Active-low bubble
                            template += `    <circle cx="27.5" cy="${H + 3}" r="3" class="$cell_id"/>\n`;
                        }
                        
                        const isResetValNonZero = resetValStr.includes('1');
                        if (isResetValNonZero) {
                            template += `    <text x="27.5" y="${H - 18}" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">${resetNetName}</text>\n`;
                            template += `    <text x="27.5" y="${H - 6}" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">(${resetValStr})</text>\n`;
                        } else {
                            template += `    <text x="27.5" y="${H - 8}" style="fill:#000; stroke:none; font-size:10px; text-anchor:middle;">${resetNetName}</text>\n`;
                        }
                    }
                    
                    // Port connection coordinates
                    template += `    <g s:x="-15" s:y="20" s:pid="D"/>\n`;
                    template += `    <g s:x="${W_rect + 15}" s:y="20" s:pid="Q"/>\n`;
                    if (hasEn) {
                        template += `    <g s:x="-15" s:y="45" s:pid="EN"/>\n`;
                        template += `    <g s:x="-15" s:y="70" s:pid="CLK"/>\n`;
                    } else {
                        template += `    <g s:x="-15" s:y="45" s:pid="CLK"/>\n`;
                    }
                    if (hasReset) {
                        const rY = H + (resetPolarity === 0 ? 6 : 0);
                        template += `    <g s:x="27.5" s:y="${rY}" s:pid="R"/>\n`;
                    }
                    
                    template += `  </g>`;
                    customSkinTemplates.push(template);
                }

                // 3. Submodule/Component Instantiation customizing
                const isInstantiation = !type.startsWith('$');
                if (isInstantiation) {
                    const templateName = `inst_${type.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    cell.type = `$${templateName}`;
                    
                    if (!addedInstTemplates.has(templateName)) {
                        addedInstTemplates.add(templateName);
                        
                        const inputs = [];
                        const outputs = [];
                        for (const port in cell.connections) {
                            const dir = cell.port_directions ? cell.port_directions[port] : 'input';
                            if (dir === 'output') {
                                outputs.push(port);
                            } else {
                                inputs.push(port);
                            }
                        }
                        
                        // Sort inputs: clocks last, others alphabetically (resets treated as regular inputs)
                        const sortInputs = (a, b) => {
                            const aClk = /clk|clock/i.test(a);
                            const bClk = /clk|clock/i.test(b);
                            if (aClk && !bClk) return 1;
                            if (!aClk && bClk) return -1;
                            return a.localeCompare(b);
                        };
                        inputs.sort(sortInputs);
                        outputs.sort((a, b) => a.localeCompare(b));
                        
                        const maxInputLen = inputs.reduce((max, p) => Math.max(max, p.length), 0);
                        const maxOutputLen = outputs.reduce((max, p) => Math.max(max, p.length), 0);
                        const cleanCellName = cellName.startsWith('\\') ? cellName.substring(1) : cellName;
                        
                        const W_rect = Math.max(80, (maxInputLen + maxOutputLen) * 6 + 30, cleanCellName.length * 6 + 25);
                        const portSpacing = 20;
                        const portStartY = 35;
                        const maxPorts = Math.max(inputs.length, outputs.length);
                        const H = Math.max(40, maxPorts * portSpacing + portStartY + 5);
                        
                        let template = `
  <g s:type="${templateName}" transform="translate(0,0)" s:width="${W_rect}" s:height="${H}">
    <s:alias val="$${templateName}"/>
    <rect width="${W_rect}" height="${H}" x="0" y="0" class="inst-block $cell_id" fill="transparent" pointer-events="all" style="cursor:pointer;" data-inst-type="${escapeXml(type)}"/>
    <text x="${W_rect / 2}" y="18" class="nodelabel $cell_id" s:attribute="ref" style="fill:#000; stroke:none; font-size:10px; font-weight:bold; text-anchor:middle; cursor:pointer;"></text>
                        `;
                        
                        // Inputs
                        for (let i = 0; i < inputs.length; i++) {
                            const portName = inputs[i];
                            const y = portStartY + i * portSpacing;
                            const isClk = /clk|clock/i.test(portName);
                            
                            template += `    <line x1="-15" x2="0" y1="${y}" y2="${y}" class="$cell_id"/>\n`;
                            
                            if (isClk) {
                                template += `    <path d="M0,${y + 5} L5,${y} L0,${y - 5}" class="$cell_id"/>\n`;
                                template += `    <text x="8" y="${y + 3}" style="fill:#000; stroke:none; font-size:10px; text-anchor:start;">${escapeXml(portName)}</text>\n`;
                            } else {
                                template += `    <text x="5" y="${y + 3}" style="fill:#000; stroke:none; font-size:10px; text-anchor:start;">${escapeXml(portName)}</text>\n`;
                            }
                            
                            template += `    <g s:x="-15" s:y="${y}" s:pid="${escapeXml(portName)}"/>\n`;
                        }
                        
                        // Outputs
                        for (let j = 0; j < outputs.length; j++) {
                            const portName = outputs[j];
                            const y = portStartY + j * portSpacing;
                            const portWidth = cell.connections[portName] ? cell.connections[portName].length : 1;
                            
                            template += `    <line x1="${W_rect}" x2="${W_rect + 15}" y1="${y}" y2="${y}" class="$cell_id"/>\n`;
                            template += `    <text x="${W_rect - 5}" y="${y + 3}" style="fill:#000; stroke:none; font-size:10px; text-anchor:end;">${escapeXml(portName)}</text>\n`;
                            
                            // Add bus slash if width > 1
                            if (portWidth > 1) {
                                template += `    <line x1="${W_rect + 4}" y1="${y + 4}" x2="${W_rect + 10}" y2="${y - 4}" class="$cell_id"/>\n`;
                                template += `    <text x="${W_rect + 7}" y="${y + 13}" style="fill:#000; stroke:none; font-size:8px; text-anchor:middle;">${portWidth}</text>\n`;
                            }
                            
                            template += `    <g s:x="${W_rect + 15}" s:y="${y}" s:pid="${escapeXml(portName)}"/>\n`;
                        }
                        
                        template += `  </g>`;
                        customSkinTemplates.push(template);
                    }
                }

                // 4. Custom N-input multiplexer customizing
                if (type.startsWith('$custom_mux_')) {
                    const typeNoPrefix = type.substring(1);
                    if (!addedInstTemplates.has(typeNoPrefix)) {
                        addedInstTemplates.add(typeNoPrefix);
                        
                        const parts = typeNoPrefix.split('_');
                        const N = parseInt(parts[2]); // custom_mux_N_wWIDTH_cellName -> parts[2] is N
                        const wPart = parts[3]; // e.g. "w7"
                        const width_Y = parseInt(wPart.substring(1));
                        const W_ctrl = Math.round(Math.log2(N));
                        
                        const H = N * 16 + 4;
                        const W_rect = 40;
                        
                        let template = `
  <g s:type="${typeNoPrefix}" transform="translate(0,0)" s:width="${W_rect}" s:height="${H}">
    <s:alias val="${type}"/>
    <path d="M0,0 L${W_rect},${H * 0.1} L${W_rect},${H * 0.9} L0,${H} Z" class="$cell_id"/>
                        `;
                        
                        // Inputs (I0 to I{N-1})
                        for (let v = 0; v < N; v++) {
                            const y_i = 10 + v * 16;
                            let hexVal = v.toString(16).toUpperCase();
                            template += `    <text x="4" y="${y_i + 3}" style="fill:#000; stroke:none; font-size:7px; font-weight:normal; font-family:sans-serif;">${hexVal}</text>\n`;
                            template += `    <g s:x="0" s:y="${y_i}" s:pid="I${v}"/>\n`;
                        }
                        
                        // Output (Y)
                        const y_Y = H / 2;
                        template += `    <line x1="${W_rect}" x2="${W_rect + 15}" y1="${y_Y}" y2="${y_Y}" class="$cell_id"/>\n`;
                        template += `    <g s:x="${W_rect + 15}" s:y="${y_Y}" s:pid="Y"/>\n`;
                        
                        // Output slash
                        if (width_Y > 1) {
                            template += `    <line x1="${W_rect + 4}" y1="${y_Y + 4}" x2="${W_rect + 10}" y2="${y_Y - 4}" class="$cell_id"/>\n`;
                            template += `    <text x="${W_rect + 7}" y="${y_Y + 13}" style="fill:#000; stroke:none; font-size:8px; text-anchor:middle;">${width_Y}</text>\n`;
                        }
                        
                        // Selector (S)
                        const x_S = W_rect / 2;
                        const y_S_start = H * 0.95;
                        const y_S_end = y_S_start + 15;
                        template += `    <line x1="${x_S}" x2="${x_S}" y1="${y_S_start}" y2="${y_S_end}" class="$cell_id"/>\n`;
                        template += `    <g s:x="${x_S}" s:y="${y_S_end}" s:pid="S"/>\n`;
                        
                        // Selector slash
                        if (W_ctrl > 1) {
                            template += `    <line x1="${x_S - 4}" y1="${y_S_start + 10}" x2="${x_S + 4}" y2="${y_S_start + 4}" class="$cell_id"/>\n`;
                            template += `    <text x="${x_S + 6}" y="${y_S_start + 9}" style="fill:#000; stroke:none; font-size:8px; text-anchor:start;">${W_ctrl}</text>\n`;
                        }
                        
                        template += `  </g>`;
                        customSkinTemplates.push(template);
                    }
                }

                // Custom N-input AND/OR gate customizing
                if (type.startsWith('$custom_and_') || type.startsWith('$custom_or_')) {
                    const typeNoPrefix = type.substring(1);
                    if (!addedInstTemplates.has(typeNoPrefix)) {
                        addedInstTemplates.add(typeNoPrefix);
                        
                        const parts = typeNoPrefix.split('_');
                        const isAnd = parts[1] === 'and';
                        const N = parseInt(parts[2]);
                        
                        const H = N * 16 + 4;
                        const W_rect = 30;
                        
                        let template = `
  <g s:type="${typeNoPrefix}" transform="translate(0,0)" s:width="${W_rect}" s:height="${H}">
    <s:alias val="${type}"/>
                        `;
                        
                        if (isAnd) {
                            template += `    <path d="M0,0 L0,${H} L15,${H} A15 ${H/2} 0 0 0 15,0 Z" class="$cell_id"/>\n`;
                        } else {
                            template += `    <path d="M0,${H} L15,${H} A15 ${H/2} 0 0 0 15,0 L0,0" class="$cell_id"/>\n`;
                            template += `    <path d="M0,0 A${(1.2 * H).toFixed(1)} ${H} 0 0 1 0,${H}" class="$cell_id"/>\n`;
                        }
                        
                        // Inputs (I0 to I{N-1})
                        const inputX = isAnd ? 0 : 3;
                        for (let v = 0; v < N; v++) {
                            const y_i = 10 + v * 16;
                            template += `    <g s:x="${inputX}" s:y="${y_i}" s:pid="I${v}"/>\n`;
                        }
                        
                        // Output (Y)
                        const y_Y = H / 2;
                        template += `    <g s:x="${W_rect}" s:y="${y_Y}" s:pid="Y"/>\n`;
                        
                        template += `  </g>`;
                        customSkinTemplates.push(template);
                    }
                }

                // 5. Standard MUX/PMUX customizing for width > 1
                if (type === '$mux' || type === '$pmux') {
                    const width = (cell.parameters && cell.parameters.WIDTH !== undefined) ? parseParamValue(cell.parameters.WIDTH) : 1;
                    const s_width = type === '$pmux' ? ((cell.parameters && cell.parameters.S_WIDTH !== undefined) ? parseParamValue(cell.parameters.S_WIDTH) : 1) : 1;
                    
                    if (width > 1 || s_width > 1) {
                        const templateName = `mux_std_${cellName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                        cell.type = `$${templateName}`;
                        
                        if (!addedInstTemplates.has(templateName)) {
                            addedInstTemplates.add(templateName);
                            
                            const W_rect = 25;
                            const H = 45;
                            
                            let template = `
  <g s:type="${templateName}" transform="translate(0,0)" s:width="${W_rect}" s:height="${H}">
    <s:alias val="$${templateName}"/>
    <path d="M0,0 L${W_rect},10 L${W_rect},35 L0,45 Z" class="$cell_id"/>
    <text x="4" y="13" style="fill:#000; stroke:none; font-size:8px; font-weight:normal; font-family:sans-serif;">0</text>
    <text x="4" y="33" style="fill:#000; stroke:none; font-size:8px; font-weight:normal; font-family:sans-serif;">1</text>
                            `;
                            
                            // Draw stub lines
                            template += `    <line x1="-15" x2="0" y1="10" y2="10" class="$cell_id"/>\n`;
                            template += `    <line x1="-15" x2="0" y1="30" y2="30" class="$cell_id"/>\n`;
                            template += `    <line x1="${W_rect}" x2="${W_rect + 15}" y1="20" y2="20" class="$cell_id"/>\n`;
                            
                            // Output slash
                            if (width > 1) {
                                template += `    <line x1="${W_rect + 4}" y1="24" x2="${W_rect + 10}" y2="16" class="$cell_id"/>\n`;
                                template += `    <text x="${W_rect + 7}" y="33" style="fill:#000; stroke:none; font-size:8px; text-anchor:middle;">${width}</text>\n`;
                            }
                            
                            // Selector line
                            const x_S = W_rect / 2;
                            template += `    <line x1="${x_S}" x2="${x_S}" y1="38" y2="53" class="$cell_id"/>\n`;
                            
                            // Selector slash
                            if (s_width > 1) {
                                template += `    <line x1="${x_S - 4}" y1="48" x2="${x_S + 4}" y2="42" class="$cell_id"/>\n`;
                                template += `    <text x="${x_S + 6}" y="47" style="fill:#000; stroke:none; font-size:8px; text-anchor:start;">${s_width}</text>\n`;
                            }
                            
                            template += `    <g s:x="-15" s:y="10" s:pid="A"/>\n`;
                            template += `    <g s:x="-15" s:y="30" s:pid="B"/>\n`;
                            template += `    <g s:x="${x_S}" s:y="53" s:pid="S"/>\n`;
                            template += `    <g s:x="${W_rect + 15}" s:y="20" s:pid="Y"/>\n`;
                            
                            template += `  </g>`;
                            customSkinTemplates.push(template);
                        }
                    }
                }
            }
        }

        // Write modified JSON back
        fs.writeFileSync(jsonFile, JSON.stringify(netlistObj, null, 2), 'utf8');

        // Create the custom skin file
        let skinContent = BASE_SKIN_TEMPLATE;
        // Inject DFF and dynamic templates
        const allCustomTemplates = staticDffTemplates + '\\n' + customSkinTemplates.join('\\n');
        const closingTagIndex = skinContent.lastIndexOf('</svg>');
        if (closingTagIndex !== -1) {
            skinContent = skinContent.substring(0, closingTagIndex) + allCustomTemplates + '\\n</svg>';
        }

        const skinFile = path.join(simTmp, 'custom_skin.svg');
        fs.writeFileSync(skinFile, skinContent, 'utf8');

        const svgFile = path.join(simTmp, `${entityName}_synth.svg`);
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const netlistRes = await execFilePromise(npxCmd, ['netlistsvg', jsonFile, '-o', svgFile, '--skin', skinFile], { cwd: simTmp });
        if (netlistRes.returncode !== 0) {
            throw new Error(l('netlistsvg.err.failed', netlistRes.stderr || netlistRes.error.message));
        }

        return { svg: fs.readFileSync(svgFile, 'utf8'), netlist: netlistObj };
    } finally {
        if (stage) stage.cleanup();
        try {
            fs.rmSync(simTmp, { recursive: true, force: true });
        } catch (e) {}
    }
}

module.exports = {
    isGhdlAvailable,
    isYosysAvailable,
    runTestbench,
    checkSyntaxOnly,
    analyzeFileInProject,
    parseDiagnostics,
    StagingArea,
    generateRtlSvg
};
