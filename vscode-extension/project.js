/**
 * @file project.js
 * @brief Gestion et modélisation d'un projet VHDL.
 * Permet de détecter les fichiers, de déterminer l'ordre de compilation
 * par analyse de dépendances, et de sauvegarder la configuration du projet.
 */

const fs = require('fs');
const path = require('path');
const { l } = require('./l10n');

/**
 * Nom du fichier de configuration du projet Questassure.
 */
const PROJECT_FILE = ".questassure.json";

/**
 * Extensions de fichiers VHDL supportées.
 */
const VHDL_EXTENSIONS = new Set([".vhd", ".vhdl"]);

// --- Motifs regex pour l'analyse des dépendances VHDL ---

/** Déclaration d'entité : entity <nom> is */
const ENTITY_DECL  = /\bentity\s+(\w+)\s+is\b/gi;

/** Déclaration de package : package <nom> is */
const PACKAGE_DECL = /\bpackage\s+(\w+)\s+is\b/gi;

/** Déclaration de configuration : configuration <nom> of */
const CONFIG_DECL  = /\bconfiguration\s+(\w+)\s+of\b/gi;

/** Référence à un composant : component <nom> */
const COMPONENT_REF = /\bcomponent\s+(\w+)\b/gi;

/** Instanciation directe d'entité : entity work.<nom> */
const ENTITY_INST   = /\bentity\s+work\.(\w+)\b/gi;

/** Utilisation du package work : use work.<nom> */
const USE_WORK      = /\buse\s+work\.(\w+)\b/gi;

/** Architecture associée à une entité : architecture <nom> of <nom_entite> */
const ARCH_OF       = /\barchitecture\s+\w+\s+of\s+(\w+)\b/gi;

/** Bloc d'entité complet pour extraction des ports */
const ENTITY_BLOCK  = /\bentity\s+(\w+)\s+is([\s\S]*?)end\s*(?:entity\b\s*(?:\w+\s*)?)?;/gi;

/** Détection du mot-clé de port */
const PORT_KW       = /\bport\s*\(/i;

/** Détection heuristique des bancs d'essai par leur nom */
const TB_NAME       = /(?:^|_)(?:tb|testbench|bench|test)(?:_|$)|(?:tb|testbench)$/i;

/** Commentaires sur une ligne */
const LINE_COMMENT  = /--[^\n]*/g;

/** Commentaires sur plusieurs lignes (blocs) */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Supprime tous les commentaires VHDL (mono-ligne et multi-lignes) d'un texte.
 *
 * @param {string} text - Le code source VHDL brut.
 * @returns {string} Le code source nettoyé de ses commentaires.
 */
function stripComments(text) {
    text = text.replace(BLOCK_COMMENT, " ");
    text = text.replace(LINE_COMMENT, " ");
    return text;
}

/**
 * Extrait toutes les occurrences correspondantes au premier groupe capturant d'une regex.
 *
 * @param {RegExp} regex - L'expression régulière globale.
 * @param {string} text - Le texte à analyser.
 * @returns {string[]} Tableau des premiers groupes de capture trouvés.
 */
function getMatches(regex, text) {
    const results = [];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
        results.push(match[1]);
    }
    return results;
}

/**
 * Recherche récursive de tous les fichiers VHDL dans un dossier donné.
 * Ignore les répertoires système et de dépendances courants (node_modules, .git, .venv, build).
 *
 * @param {string} dir - Chemin absolu du dossier à explorer.
 * @returns {string[]} Liste triée des chemins absolus de fichiers VHDL trouvés.
 */
function findVhdlFiles(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    
    let list;
    try {
        list = fs.readdirSync(dir);
    } catch (e) {
        return results;
    }
    
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (e) {
            return;
        }
        if (stat && stat.isDirectory()) {
            // Ignore les répertoires de build ou de dépendance pour optimiser la recherche
            if (file !== 'node_modules' && file !== '.git' && file !== '.venv' && file !== 'build') {
                results = results.concat(findVhdlFiles(fullPath));
            }
        } else {
            const ext = path.extname(file).toLowerCase();
            if (VHDL_EXTENSIONS.has(ext)) {
                results.push(path.resolve(fullPath));
            }
        }
    });
    return results.sort();
}

/**
 * Modélise un projet VHDL et gère ses configurations et dépendances.
 */
class VhdlProject {
    /**
     * @param {string} root - Dossier racine du projet.
     * @param {string[]} files - Liste des fichiers VHDL du projet.
     * @param {string|null} topTestbench - Nom du banc d'essai principal.
     * @param {string} workLibrary - Bibliothèque de travail VHDL par défaut ("work").
     * @param {Object.<string, string>} fileLibraries - Dictionnaire associant un chemin de fichier à sa bibliothèque.
     */
    constructor(root, files = [], topTestbench = null, workLibrary = "work", fileLibraries = {}) {
        this.root = path.resolve(root);
        this.files = files.map(f => path.resolve(f));
        this.top_testbench = topTestbench;
        this.work_library = workLibrary;
        this.file_libraries = fileLibraries;
    }

    /**
     * Découvre ou charge un projet VHDL depuis un dossier racine.
     * S'il existe un fichier `.questassure.json`, charge ses configurations.
     * Sinon, effectue une découverte automatique des fichiers.
     *
     * @param {string} root - Dossier racine.
     * @returns {VhdlProject} Instance du projet initialisé.
     */
    static discover(root) {
        root = path.resolve(root);
        const files = findVhdlFiles(root);
        const configPath = path.join(root, PROJECT_FILE);
        if (fs.existsSync(configPath)) {
            try {
                const project = VhdlProject.load(configPath);
                project.files = project.files.filter(f => fs.existsSync(f));
                if (project.files.length > 0) {
                    return project;
                }
                project.files = files;
                return project;
            } catch (e) {
                console.error("Failed to load config, returning discovered project:", e);
            }
        }
        return new VhdlProject(root, files);
    }

    /**
     * Charge la configuration du projet depuis le fichier JSON spécifié.
     *
     * @param {string} configPath - Chemin du fichier `.questassure.json`.
     * @returns {VhdlProject} Instance du projet.
     */
    static load(configPath) {
        const content = fs.readFileSync(configPath, 'utf8');
        const data = JSON.parse(content);
        const root = path.dirname(configPath);
        const files = (data.files || []).map(f => path.resolve(root, f));
        return new VhdlProject(
            root,
            files,
            data.top_testbench,
            data.work_library || "work",
            data.file_libraries || {}
        );
    }

    /**
     * Sauvegarde la configuration courante du projet dans le fichier `.questassure.json`.
     *
     * @returns {string} Le chemin absolu du fichier de configuration sauvegardé.
     */
    save() {
        const configPath = path.join(this.root, PROJECT_FILE);
        const data = {
            top_testbench: this.top_testbench,
            work_library: this.work_library,
            files: this.files.map(f => this.relative_path(f)),
            file_libraries: this.file_libraries
        };
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
        return configPath;
    }

    /**
     * Lit le contenu d'un fichier source et en retire les commentaires.
     *
     * @private
     * @param {string} filePath - Chemin du fichier.
     * @returns {string} Code épuré.
     */
    _readSource(filePath) {
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            return stripComments(text);
        } catch (e) {
            return "";
        }
    }

    /**
     * Extrait les entités, packages et configurations déclarés dans un fichier.
     *
     * @private
     * @param {string} filePath - Chemin du fichier.
     * @returns {Set.<string>} Ensemble des unités déclarées en minuscules.
     */
    _declaredUnits(filePath) {
        const text = this._readSource(filePath);
        const names = new Set();
        [ENTITY_DECL, PACKAGE_DECL, CONFIG_DECL].forEach(pat => {
            getMatches(pat, text).forEach(name => names.add(name.toLowerCase()));
        });
        return names;
    }

    /**
     * Extrait les unités référencées (dépendances) dans un fichier.
     *
     * @private
     * @param {string} filePath - Chemin du fichier.
     * @returns {Set.<string>} Ensemble des unités référencées en minuscules.
     */
    _referencedUnits(filePath) {
        const text = this._readSource(filePath);
        const names = new Set();
        [COMPONENT_REF, ENTITY_INST, USE_WORK, ARCH_OF].forEach(pat => {
            getMatches(pat, text).forEach(name => names.add(name.toLowerCase()));
        });
        return names;
    }

    /**
     * Calcule l'ordre de compilation optimal des fichiers VHDL par tri topologique.
     * Résout les dépendances entre les entités déclarées et les références.
     *
     * @returns {string[]} Liste ordonnée de chemins de fichiers à compiler.
     */
    compilation_order() {
        const files = [...this.files];
        if (files.length <= 1) {
            return files;
        }

        const unitToFile = new Map();
        const fileDeclared = new Map();
        
        // Étape 1: Cartographier chaque unité VHDL déclarée vers son fichier source
        for (const f of files) {
            const declared = this._declaredUnits(f);
            fileDeclared.set(f, declared);
            for (const name of declared) {
                unitToFile.set(name, f);
            }
        }

        // Étape 2: Construire le graphe des dépendances de fichiers
        const deps = new Map();
        for (const f of files) {
            deps.set(f, new Set());
            const refs = this._referencedUnits(f);
            for (const ref of refs) {
                const provider = unitToFile.get(ref);
                if (provider && provider !== f) {
                    deps.get(f).add(provider);
                }
            }
        }

        // Étape 3: Initialiser les structures du tri topologique (Kahn)
        const inDegree = new Map();
        const dependents = new Map();
        for (const f of files) {
            inDegree.set(f, deps.get(f).size);
            dependents.set(f, new Set());
        }

        for (const [f, predecessors] of deps.entries()) {
            for (const pred of predecessors) {
                dependents.get(pred).add(f);
            }
        }

        // Étape 4: Traiter d'abord les fichiers sans dépendances (feuilles)
        const ready = [];
        for (const f of files) {
            if (inDegree.get(f) === 0) {
                ready.push(f);
            }
        }
        ready.sort();

        const ordered = [];
        while (ready.length > 0) {
            const f = ready.shift();
            ordered.push(f);

            const depsList = Array.from(dependents.get(f)).sort();
            for (const dep of depsList) {
                inDegree.set(dep, inDegree.get(dep) - 1);
                if (inDegree.get(dep) === 0) {
                    ready.push(dep);
                }
            }
            ready.sort();
        }

        // Étape 5: Inclure les fichiers orphelins ou impliqués dans des cycles pour éviter de les perdre
        const emitted = new Set(ordered);
        for (const f of files) {
            if (!emitted.has(f)) {
                ordered.push(f);
            }
        }

        return ordered;
    }

    /**
     * Recherche toutes les entités définies dans le projet.
     *
     * @returns {Array.<[string, string]>} Liste de paires [Nom de l'entité, Chemin du fichier].
     */
    find_entities() {
        const seen = new Set();
        const results = [];
        for (const f of this.compilation_order()) {
            const text = this._readSource(f);
            getMatches(ENTITY_DECL, text).forEach(name => {
                const key = name.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push([name, f]);
                }
            });
        }
        return results;
    }

    /**
     * Identifie heuristiquement tous les bancs d'essai (testbenches) du projet.
     * Se base sur le nom (ex: suffixe _tb) ou l'absence de ports d'entrée/sortie.
     *
     * @returns {Array.<[string, string]>} Liste de paires [Nom du banc d'essai, Chemin du fichier].
     */
    find_testbenches() {
        const tbs = [];
        const others = [];

        for (const f of this.compilation_order()) {
            const text = this._readSource(f);
            let match;
            ENTITY_BLOCK.lastIndex = 0;
            while ((match = ENTITY_BLOCK.exec(text)) !== null) {
                const name = match[1];
                const body = match[2];
                const isTbName = TB_NAME.test(name);
                const hasNoPort = !PORT_KW.test(body);
                if (isTbName || hasNoPort) {
                    tbs.push([name, f]);
                } else {
                    others.push([name, f]);
                }
            }
        }

        const seen = new Set();
        const result = [];
        tbs.sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));

        for (const [name, f] of tbs.concat(others)) {
            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push([name, f]);
            }
        }
        return result;
    }

    /**
     * Met à jour récursivement les bibliothèques des dépendances requises pour simuler une entité donnée.
     *
     * @param {string} libName - Nom de la bibliothèque cible.
     * @param {string} entityName - Nom de l'entité à simuler.
     */
    update_library_for_simulation(libName, entityName) {
        const unitToFile = new Map();
        const entityPat = /\bentity\s+([a-zA-Z0-9_]+)\b/gi;
        const pkgPat    = /\bpackage\s+([a-zA-Z0-9_]+)\b/gi;
        const configPat = /\bconfiguration\s+([a-zA-Z0-9_]+)\b/gi;

        for (const filePath of this.files) {
            if (!fs.existsSync(filePath)) continue;
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                getMatches(entityPat, content).forEach(name => unitToFile.set(name.toLowerCase(), filePath));
                getMatches(pkgPat, content).forEach(name => unitToFile.set(name.toLowerCase(), filePath));
                getMatches(configPat, content).forEach(name => unitToFile.set(name.toLowerCase(), filePath));
            } catch (e) {}
        }

        const topFile = unitToFile.get(entityName.toLowerCase());
        if (!topFile) return;

        const libraryFiles = new Set([topFile]);
        const queue = [topFile];
        const wordPat = /[a-zA-Z0-9_]+/g;

        // Exploration BFS (Breadth-First Search) des dépendances
        while (queue.length > 0) {
            const currentFile = queue.shift();
            try {
                const content = fs.readFileSync(currentFile, 'utf8');
                const words = new Set(content.match(wordPat) || []);
                for (const word of words) {
                    const wordLower = word.toLowerCase();
                    if (unitToFile.has(wordLower)) {
                        const depFile = unitToFile.get(wordLower);
                        if (!libraryFiles.has(depFile)) {
                            libraryFiles.add(depFile);
                            queue.push(depFile);
                        }
                    }
                }
            } catch (e) {}
        }

        // Assigner la bibliothèque spécifiée à tous les fichiers dépendants
        for (const filePath of libraryFiles) {
            const relPath = this.relative_path(filePath);
            this.file_libraries[relPath] = libName;
        }
    }

    /**
     * Ajoute un fichier VHDL au projet s'il n'est pas déjà présent.
     *
     * @param {string} filePath - Chemin absolu du fichier à ajouter.
     * @throws {Error} Si le fichier n'a pas d'extension VHDL valide.
     */
    add_file(filePath) {
        filePath = path.resolve(filePath);
        const ext = path.extname(filePath).toLowerCase();
        if (!VHDL_EXTENSIONS.has(ext)) {
            throw new Error(l('project.err.not_vhdl', filePath));
        }
        if (!this.files.includes(filePath)) {
            this.files.push(filePath);
            this.files.sort();
        }
    }

    /**
     * Convertit un chemin absolu en chemin relatif par rapport à la racine du projet.
     *
     * @param {string} filePath - Le chemin absolu.
     * @returns {string} Le chemin relatif avec séparateurs homogénéisés (slashes `/`).
     */
    relative_path(filePath) {
        try {
            const rel = path.relative(this.root, path.resolve(filePath));
            return rel.split(path.sep).join('/');
        } catch (e) {
            return path.resolve(filePath).split(path.sep).join('/');
        }
    }
}

module.exports = {
    VhdlProject,
    findVhdlFiles,
    stripComments,
    getMatches
};
