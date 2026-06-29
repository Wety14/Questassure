/**
 * @file rtl_extractor.js
 * @brief Extracteur de schémas RTL et de machines à états finis (FSM) à partir de fichiers VHDL.
 * Permet d'analyser le code source pour identifier les ports, les états, les transitions
 * et de générer des diagrammes au format SVG interactif ou Mermaid.
 */

const fs = require('fs');
const { l } = require('./l10n');

/**
 * Nettoie et simplifie les conditions logiques VHDL pour un rendu de diagramme lisible.
 * Convertit par exemple `signal = '1'` en `signal`, `signal = '0'` en `not signal` et traduit les entités HTML.
 *
 * @param {string} cond - La condition logique brute.
 * @returns {string} La condition nettoyée et simplifiée.
 */
function cleanCondition(cond) {
    if (!cond) return 'default';
    let cleaned = cond.trim();
    // Simplifie 'signal = '1'' ou '"1"' en 'signal'
    cleaned = cleaned.replace(/\b(\w+)\s*=\s*['"]1['"]/gi, '$1');
    // Simplifie 'signal = '0'' ou '"0"' en 'not signal'
    cleaned = cleaned.replace(/\b(\w+)\s*=\s*['"]0['"]/gi, 'not $1');
    // Simplifie 'not signal = '1'' en 'not signal'
    cleaned = cleaned.replace(/not\s*\(?\s*(\w+)\s*=\s*['"]1['"]\s*\)?/gi, 'not $1');
    // Simplifie 'not signal = '0'' en 'signal'
    cleaned = cleaned.replace(/not\s*\(?\s*(\w+)\s*=\s*['"]0['"]\s*\)?/gi, '$1');
    // Remplacer les entités HTML de comparaison
    cleaned = cleaned.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return cleaned.trim();
}

/**
 * Analyse une séquence d'instructions VHDL et extrait les affectations de signaux
 * associées à leurs conditions d'exécution (en gérant une pile de conditions IF/ELSIF/ELSE).
 *
 * @param {string} statements - Chaîne textuelle contenant les instructions du processus.
 * @returns {Object[]} Liste d'affectations contenant { sig, val, cond }.
 */
function parseStatements(statements) {
    const results = [];
    // Regex pour détecter les mots-clés conditionnels et les instructions d'affectation
    const regex = /\bif\b|\belsif\b|\belse\b|\bend\s+if\b|(\w+)\s*<=\s*([^;]+);/gi;
    
    let match;
    const condStack = []; // Pile pour suivre l'imbrication des conditions logiques
    
    while ((match = regex.exec(statements)) !== null) {
        const token = match[0].toLowerCase();
        
        if (token === 'if' || token === 'elsif') {
            const searchStart = regex.lastIndex;
            const thenIdx = statements.toLowerCase().indexOf('then', searchStart);
            if (thenIdx !== -1) {
                const cond = statements.substring(searchStart, thenIdx).trim();
                if (token === 'elsif' && condStack.length > 0) {
                    condStack.pop();
                }
                condStack.push(cond);
                regex.lastIndex = thenIdx + 4; // avancer après le mot-clé 'then'
            }
        } else if (token === 'else') {
            if (condStack.length > 0) {
                const prevCond = condStack.pop();
                condStack.push(`not (${prevCond})`);
            } else {
                condStack.push('else');
            }
        } else if (token.startsWith('end')) {
            if (condStack.length > 0) {
                condStack.pop();
            }
        } else if (match[1]) {
            // C'est une affectation de signal de type "sig <= val;"
            const sig = match[1];
            const val = match[2].trim();
            const combinedCond = condStack.length > 0 ? condStack.join(' and ') : 'default';
            results.push({ sig, val, cond: combinedCond });
        }
    }
    return results;
}

/**
 * Classe chargée d'extraire les éléments structurels RTL et les machines à états (FSM).
 */
class RtlExtractor {
    /**
     * @param {string} content - Le code source VHDL complet.
     */
    constructor(content) {
        this.content = content;
        this.cleanContent = this._removeComments(content);
    }

    /**
     * Supprime les commentaires mono-ligne pour faciliter le parsing.
     *
     * @private
     * @param {string} text - Code brut.
     * @returns {string} Code nettoyé.
     */
    _removeComments(text) {
        return text.replace(/--.*$/gm, '');
    }

    /**
     * Analyse la déclaration de l'entité pour en extraire les ports (entrées/sorties).
     *
     * @returns {Object[]} Liste des ports trouvés avec leur direction, type et taille de bus.
     */
    extractPorts() {
        const ports = [];
        const portIdx = this.cleanContent.toLowerCase().indexOf('port');
        if (portIdx !== -1) {
            const openParenIdx = this.cleanContent.indexOf('(', portIdx);
            if (openParenIdx !== -1) {
                let depth = 1;
                let i = openParenIdx + 1;
                // Scanner pour trouver la parenthèse fermante correspondante au bloc PORT
                while (i < this.cleanContent.length && depth > 0) {
                    if (this.cleanContent[i] === '(') depth++;
                    else if (this.cleanContent[i] === ')') depth--;
                    i++;
                }
                
                if (depth === 0) {
                    const portText = this.cleanContent.substring(openParenIdx + 1, i - 1);
                    const decls = portText.split(';');
                    for (const decl of decls) {
                        if (decl.includes(':')) {
                            const parts = decl.split(':');
                            const names = parts[0].split(',').map(n => n.trim());
                            const dirType = parts[1].trim();
                            const tokens = dirType.split(/\s+/);
                            if (tokens.length >= 2) {
                                const direction = tokens[0].toLowerCase();
                                const typeName = tokens.slice(1).join(' ');
                                
                                // Détecter la taille si c'est un vecteur std_logic_vector
                                const rangeMatch = /std_logic_vector\s*\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)/i.exec(typeName);
                                let size = 1;
                                if (rangeMatch) {
                                    const left = parseInt(rangeMatch[1]);
                                    const right = parseInt(rangeMatch[3]);
                                    size = Math.abs(left - right) + 1;
                                }
                                
                                for (const n of names) {
                                    if (n) {
                                        ports.push({ name: n, direction, typeName, size });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return ports;
    }

    /**
     * Identifie les valeurs d'affectation par défaut des ports de sortie du processus principal.
     * Ces valeurs par défaut évitent l'inférence de latches.
     *
     * @returns {Object.<string, string>} Dictionnaire associant le nom du port de sortie à sa valeur par défaut.
     */
    extractDefaultOutputs() {
        const ports = this.extractPorts();
        const outputNames = new Set(ports.filter(p => p.direction === 'out').map(p => p.name.toLowerCase()));
        const defaultOutputs = {};
        
        // Parcourir tous les blocs processus
        const processRegex = /(?:(\w+)\s*:\s*)?process\s*\((.*?)\)[\s\S]*?\bbegin\b([\s\S]*?)\bend\s+process\b/gi;
        let pm;
        let maxMatchCount = -1;
        let bestDefaultBlock = "";
        
        while ((pm = processRegex.exec(this.cleanContent)) !== null) {
            const body = pm[3];
            const parts = body.split(/\bcase\b/i);
            const preCase = parts[0]; // Zone avant le bloc CASE (contenant généralement les valeurs par défaut)
            
            let count = 0;
            const assignRegex = /(\w+)\s*<=\s*([^;]+);/g;
            let am;
            while ((am = assignRegex.exec(preCase)) !== null) {
                const sig = am[1].trim().toLowerCase();
                if (outputNames.has(sig)) {
                    count++;
                }
            }
            
            if (count > maxMatchCount) {
                maxMatchCount = count;
                bestDefaultBlock = preCase;
            }
        }
        
        if (bestDefaultBlock) {
            const assignRegex = /(\w+)\s*<=\s*([^;]+);/g;
            let am;
            while ((am = assignRegex.exec(bestDefaultBlock)) !== null) {
                const sig = am[1].trim();
                const val = am[2].trim();
                const sigLower = sig.toLowerCase();
                if (outputNames.has(sigLower)) {
                    defaultOutputs[sigLower] = val.replace(/'/g, '');
                }
            }
        }
        
        return defaultOutputs;
    }

    /**
     * Détermine l'état initial de la machine à états finis (FSM).
     * Repère l'affectation faite lors du signal de Reset (rst, resetn, etc.).
     *
     * @param {Object} fsm - L'objet machine à états en cours d'analyse.
     * @returns {string} Le nom de l'état initial.
     */
    extractInitialState(fsm) {
        // 1. Recherche d'une condition d'activation de reset standard suivie de l'état
        const resetRegex = /(?:resetn|rstn|rst|reset)\s*=\s*'?[01]'?\s+then\s+(\w+)\s*<=\s*(\w+)/i;
        const match = resetRegex.exec(this.cleanContent);
        if (match && fsm.states.includes(match[2])) {
            return match[2];
        }
        
        // 2. Recherche alternative au cas où la syntaxe contienne des retours à la ligne ou des espaces multiples
        for (const state of fsm.states) {
            const fallbackRegex = new RegExp(`(?:resetn|rstn|rst|reset)\\s*=\\s*'?[01]'?\\s+then[\\s\\S]*?\\b(\\w+)\\s*<=\\s*${state}\\b`, 'i');
            const fbMatch = fallbackRegex.exec(this.cleanContent);
            if (fbMatch) {
                return state;
            }
        }
        
        return fsm.states[0]; // Par défaut, retourne le premier état trouvé
    }

    /**
     * Extrait l'ensemble des machines à états finis (FSM) définies dans le code VHDL.
     * Recherche d'abord les types énumérés, puis les signaux associés et enfin les blocs CASE...IS.
     *
     * @returns {Object[]} Liste des FSM extraites.
     */
    extractFsms() {
        const fsms = [];
        const typeRegex = /type\s+(\w+)\s+is\s*\(([\s\S]*?)\)\s*;/gi;
        let tm;
        // Détecter la définition du type énuméré des états
        while ((tm = typeRegex.exec(this.cleanContent)) !== null) {
            const typeName = tm[1];
            const states = tm[2].split(',').map(s => s.trim());
            if (states.length > 1) {
                const fsm = {
                    name: typeName,
                    states: states,
                    stateSignal: "",
                    stateDetails: {}
                };
                for (const s of states) {
                    fsm.stateDetails[s] = { name: s, transitions: [], outputs: {} };
                }
                fsms.push(fsm);
            }
        }

        // Associer les signaux de registre d'état et parser les transitions du bloc CASE
        for (const fsm of fsms) {
            const sigRegex = new RegExp(`signal\\s+(\\w+(?:\\s*,\\s*\\w+)*)\\s*:\\s*${fsm.name}\\b`, 'i');
            const sigMatch = sigRegex.exec(this.cleanContent);
            if (sigMatch) {
                fsm.stateSignal = sigMatch[1].split(',').map(s => s.trim())[0];
            }

            const caseRegex = /case\s+(\w+)\s+is([\s\S]*?)end\s+case\s*;/gi;
            let cm;
            while ((cm = caseRegex.exec(this.cleanContent)) !== null) {
                const body = cm[2];
                if (fsm.states.some(s => body.includes(s))) {
                    this._parseFsmBody(fsm, body);
                }
            }
        }
        return fsms;
    }

    /**
     * Analyse le corps d'un bloc CASE pour y extraire les transitions et les sorties d'état de la FSM.
     *
     * @private
     * @param {Object} fsm - La FSM en cours de traitement.
     * @param {string} body - Le code à l'intérieur du bloc case.
     */
    _parseFsmBody(fsm, body) {
        const parts = body.split(/\bwhen\b\s+/i);
        for (const part of parts) {
            if (!part.includes('=>')) {
                continue;
            }
            const [stateClauseRaw, statements] = part.split(/=>([\s\S]*)/);
            const stateClause = stateClauseRaw.trim();

            const matchedStates = fsm.states.filter(s => s.toLowerCase() === stateClause.toLowerCase());
            if (matchedStates.length === 0) {
                continue;
            }

            const stateName = matchedStates[0];
            const st = fsm.stateDetails[stateName];

            const parsed = parseStatements(statements);
            for (const item of parsed) {
                const sig = item.sig;
                const val = item.val;
                const cond = item.cond;
                
                const sigLower = sig.toLowerCase();
                const valLower = val.toLowerCase();
                
                // Si l'affectation cible le registre d'état, c'est une transition d'état
                if (sigLower === 'state_reg' || sigLower === 'state_next') {
                    if (fsm.states.some(s => s.toLowerCase() === valLower)) {
                        const targetState = fsm.states.find(s => s.toLowerCase() === valLower);
                        st.transitions.push({ to: targetState, cond: cond });
                    }
                } else if (fsm.states.some(s => s.toLowerCase() === valLower)) {
                    const targetState = fsm.states.find(s => s.toLowerCase() === valLower);
                    st.transitions.push({ to: targetState, cond: cond });
                } else {
                    // Sinon, c'est une affectation de sortie associée à cet état
                    const cleanVal = val.replace(/'/g, '');
                    if (cond === 'default') {
                        st.outputs[sig] = cleanVal;
                    } else {
                        st.outputs[`${sig} (if ${cond})`] = cleanVal;
                    }
                }
            }
        }
    }

    /**
     * Génère un schéma vectoriel SVG représentant la machine à états (FSM).
     * Calcule la disposition géométrique circulaire des nœuds et dessine les flèches de transition.
     *
     * @param {Object} fsm - La machine à états à tracer.
     * @param {boolean} isNoBg - Vrai pour désactiver le fond blanc opaque du SVG.
     * @returns {string} Le code XML/SVG complet généré.
     */
    generateFsmSvg(fsm, isNoBg) {
        const defaultOutputs = this.extractDefaultOutputs();
        const ports = this.extractPorts();
        const initialState = this.extractInitialState(fsm);
        
        // Coordonnées du centre du graphe et rayons de l'ellipse
        const X_c = 360;
        const Y_c = 330;
        const R_x = 210;
        const R_y = 190;
        
        // Extraire les sorties spécifiques de chaque état (qui diffèrent de la valeur par défaut)
        const stateOutputLines = {};
        for (const s of fsm.states) {
            const st = fsm.stateDetails[s];
            const lines = [];
            for (const [sig, val] of Object.entries(st.outputs)) {
                const defVal = defaultOutputs[sig.toLowerCase()];
                if (defVal !== val) {
                    lines.push(`${sig} = ${val}`);
                }
            }
            stateOutputLines[s] = lines;
        }
        
        const nodeHtml = [];
        const nodePositions = {};
        // Placer les nœuds (états) de façon circulaire
        for (let i = 0; i < fsm.states.length; i++) {
            const s = fsm.states[i];
            const theta = -Math.PI / 2 + (2 * Math.PI * i) / fsm.states.length;
            const x = X_c + R_x * Math.cos(theta);
            const y = Y_c + R_y * Math.sin(theta);
            
            const lines = stateOutputLines[s] || [];
            const maxLen = Math.max(s.length, ...lines.map(l => l.length));
            
            // Calculer la taille optimale de l'ellipse en fonction de la longueur du texte
            const rx = Math.max(38, maxLen * 4.2 + 10);
            const ry = Math.max(30, (lines.length + 1) * 12 + 10);
            
            nodePositions[s] = { x, y, rx, ry, theta };
            
            const isInitial = (s === initialState);
            
            let g = `  <g class="state-node" transform="translate(${x}, ${y})">\n`;
            g += `    <ellipse cx="0" cy="0" rx="${rx}" ry="${ry}" fill="transparent" pointer-events="all" stroke="#0f172a" stroke-width="2" />\n`;
            if (isInitial) {
                // Double cercle pour marquer l'état initial
                g += `    <ellipse cx="0" cy="0" rx="${rx - 4}" ry="${ry - 4}" fill="transparent" pointer-events="all" stroke="#0f172a" stroke-width="1.5" />\n`;
            }
            
            const startY = lines.length > 0 ? -Math.round((10 + lines.length * 13) / 2) + 3 : 5;
            g += `    <text x="0" y="${startY}" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" text-anchor="middle" fill="#0f172a">${s}</text>\n`;
            
            if (lines.length > 0) {
                const sepY = startY + 8;
                g += `    <line x1="-${rx * 0.6}" y1="${sepY}" x2="${rx * 0.6}" y2="${sepY}" stroke="#cbd5e1" stroke-width="1" />\n`;
                for (let j = 0; j < lines.length; j++) {
                    const lineY = sepY + 15 + j * 13;
                    g += `    <text x="0" y="${lineY}" font-family="system-ui, -apple-system, sans-serif" font-size="9.5" text-anchor="middle" fill="#334155">${lines[j]}</text>\n`;
                }
            }
            g += `  </g>`;
            nodeHtml.push(g);
        }
        
        const transitionHtml = [];
        // Tracer les fils de transition
        for (const [fromState, st] of Object.entries(fsm.stateDetails)) {
            const fromPos = nodePositions[fromState];
            if (!fromPos) continue;
            
            for (const t of st.transitions) {
                const toState = t.to;
                const toPos = nodePositions[toState];
                if (!toPos) continue;
                
                const cond = cleanCondition(t.cond);
                
                // Rebouclage sur soi-même (Self Loop)
                if (fromState === toState) {
                    const theta = fromPos.theta;
                    const startAng = theta - 0.22;
                    const endAng = theta + 0.22;
                    
                    const psx = fromPos.x + fromPos.rx * Math.cos(startAng);
                    const psy = fromPos.y + fromPos.ry * Math.sin(startAng);
                    const pex = fromPos.x + fromPos.rx * Math.cos(endAng);
                    const pey = fromPos.y + fromPos.ry * Math.sin(endAng);
                    
                    const loopLen = 40;
                    const c1x = psx + loopLen * Math.cos(startAng);
                    const c1y = psy + loopLen * Math.sin(startAng);
                    const c2x = pex + loopLen * Math.cos(endAng);
                    const c2y = pey + loopLen * Math.sin(endAng);
                    
                    const labelId = `trans_${fromState}_to_${toState}_${cond.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    transitionHtml.push(`  <path id="${labelId}" class="fsm-transition-wire" data-from="${fromState}" data-to="${toState}" data-cond="${cond}" d="M ${psx} ${psy} C ${c1x} ${c1y} ${c2x} ${c2y} ${pex} ${pey}" fill="none" stroke="#0f172a" stroke-width="2" marker-end="url(#arrow)" pointer-events="stroke" style="cursor: pointer;" />`);
                    
                    const lx = fromPos.x + (fromPos.rx + loopLen + 5) * Math.cos(theta);
                    const ly = fromPos.y + (fromPos.ry + loopLen + 5) * Math.sin(theta);
                    
                    if (cond !== 'default') {
                        const labelWidth = cond.length * 6 + 10;
                        transitionHtml.push(`  <g class="fsm-transition-label" data-from="${fromState}" data-to="${toState}" data-cond="${cond}" data-wire-id="${labelId}" transform="translate(${lx}, ${ly})" style="cursor: pointer;">`);
                        transitionHtml.push(`    <rect x="-${labelWidth / 2}" y="-8" width="${labelWidth}" height="16" fill="#ffffff" rx="3" opacity="0.9" />`);
                        transitionHtml.push(`    <text x="0" y="3" font-family="system-ui, -apple-system, sans-serif" font-size="10" font-weight="bold" text-anchor="middle" fill="#0f172a">${cond}</text>`);
                        transitionHtml.push(`  </g>`);
                    }
                } else {
                    // Transition classique d'un état A vers B
                    const dx = toPos.x - fromPos.x;
                    const dy = toPos.y - fromPos.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    const ux = dx / len;
                    const uy = dy / len;
                    
                    let nx = -uy;
                    let ny = ux;
                    
                    // Ajustement de la courbure si transition bidirectionnelle
                    const hasReverse = st.transitions.some(rev => rev.to === fromState) || 
                                       (fsm.stateDetails[toState] && fsm.stateDetails[toState].transitions.some(rev => rev.to === fromState));
                    
                    let curveOffset = 15;
                    
                    if (hasReverse) {
                        curveOffset = 35; // Écarter les courbes pour ne pas se chevaucher
                    } else {
                        // Monodirectionnel : courber vers l'extérieur du centre de la FSM
                        const mx = (fromPos.x + toPos.x) / 2;
                        const my = (fromPos.y + toPos.y) / 2;
                        const voutx = mx - X_c;
                        const vouty = my - Y_c;
                        const dot = nx * voutx + ny * vouty;
                        if (dot < 0) {
                            nx = -nx;
                            ny = -ny;
                        }
                    }
                    
                    const cx = (fromPos.x + toPos.x) / 2 + curveOffset * nx;
                    const cy = (fromPos.y + toPos.y) / 2 + curveOffset * ny;
                    
                    const alpha = Math.atan2(cy - fromPos.y, cx - fromPos.x);
                    const psx = fromPos.x + fromPos.rx * Math.cos(alpha);
                    const psy = fromPos.y + fromPos.ry * Math.sin(alpha);
                    
                    const beta = Math.atan2(cy - toPos.y, cx - toPos.x);
                    const pex = toPos.x + toPos.rx * Math.cos(beta);
                    const pey = toPos.y + toPos.ry * Math.sin(beta);
                    
                    const labelId = `trans_${fromState}_to_${toState}_${cond.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    transitionHtml.push(`  <path id="${labelId}" class="fsm-transition-wire" data-from="${fromState}" data-to="${toState}" data-cond="${cond}" d="M ${psx} ${psy} Q ${cx} ${cy} ${pex} ${pey}" fill="none" stroke="#0f172a" stroke-width="2" marker-end="url(#arrow)" pointer-events="stroke" style="cursor: pointer;" />`);
                    
                    const lmx = 0.25 * psx + 0.5 * cx + 0.25 * pex;
                    const lmy = 0.25 * psy + 0.5 * cy + 0.25 * pey;
                    const lx = lmx + 13 * nx;
                    const ly = lmy + 13 * ny;
                    
                    if (cond !== 'default') {
                        const labelWidth = cond.length * 6 + 10;
                        transitionHtml.push(`  <g class="fsm-transition-label" data-from="${fromState}" data-to="${toState}" data-cond="${cond}" data-wire-id="${labelId}" transform="translate(${lx}, ${ly})" style="cursor: pointer;">`);
                        transitionHtml.push(`    <rect x="-${labelWidth / 2}" y="-8" width="${labelWidth}" height="16" fill="#ffffff" rx="3" opacity="0.9" />`);
                        transitionHtml.push(`    <text x="0" y="3" font-family="system-ui, -apple-system, sans-serif" font-size="9.5" font-weight="bold" text-anchor="middle" fill="#0f172a">${cond}</text>`);
                        transitionHtml.push(`  </g>`);
                    }
                }
            }
        }
        
        // Construction du tableau récapitulatif des Entrées/Sorties de l'entité VHDL
        const inputs = ports.filter(p => p.direction === 'in' && !['clk', 'clock', 'resetn', 'reset', 'rstn', 'rst'].includes(p.name.toLowerCase()));
        const outputs = ports.filter(p => p.direction === 'out');
        const rows = [];
        const maxRows = Math.max(inputs.length, outputs.length);
        for (let r = 0; r < maxRows; r++) {
            const inp = inputs[r];
            const out = outputs[r];
            const inpStr = inp ? (inp.size > 1 ? `${inp.name}(${inp.size})` : inp.name) : "";
            const outStr = out ? (out.size > 1 ? `${out.name}(${out.size})` : out.name) : "";
            const defStr = out ? (defaultOutputs[out.name.toLowerCase()] || "0") : "";
            rows.push({ input: inpStr, output: outStr, defaultValue: defStr });
        }
        
        const tableX = 830;
        const tableY = 80;
        const colWidths = [120, 160, 150];
        const rowHeight = 35;
        
        const tableHtml = [];
        tableHtml.push(`  <g class="table-header">`);
        tableHtml.push(`    <rect x="${tableX}" y="${tableY}" width="${colWidths[0] + colWidths[1] + colWidths[2]}" height="${rowHeight}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" />`);
        tableHtml.push(`    <text x="${tableX + 12}" y="${tableY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${l('svg.table.inputs')}</text>`);
        tableHtml.push(`    <text x="${tableX + colWidths[0] + 12}" y="${tableY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${l('svg.table.outputs')}</text>`);
        tableHtml.push(`    <text x="${tableX + colWidths[0] + colWidths[1] + 12}" y="${tableY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${l('svg.table.defaults')}</text>`);
        tableHtml.push(`    <line x1="${tableX + colWidths[0]}" y1="${tableY}" x2="${tableX + colWidths[0]}" y2="${tableY + rowHeight}" stroke="#cbd5e1" stroke-width="1.5" />`);
        tableHtml.push(`    <line x1="${tableX + colWidths[0] + colWidths[1]}" y1="${tableY}" x2="${tableX + colWidths[0] + colWidths[1]}" y2="${tableY + rowHeight}" stroke="#cbd5e1" stroke-width="1.5" />`);
        tableHtml.push(`  </g>`);
        
        for (let r = 0; r < rows.length; r++) {
            const rowY = tableY + (r + 1) * rowHeight;
            const bg = r % 2 === 0 ? "#ffffff" : "#f8fafc";
            
            tableHtml.push(`  <g class="table-row">`);
            tableHtml.push(`    <rect x="${tableX}" y="${rowY}" width="${colWidths[0] + colWidths[1] + colWidths[2]}" height="${rowHeight}" fill="${bg}" stroke="#e2e8f0" stroke-width="1" />`);
            tableHtml.push(`    <line x1="${tableX + colWidths[0]}" y1="${rowY}" x2="${tableX + colWidths[0]}" y2="${rowY + rowHeight}" stroke="#e2e8f0" stroke-width="1" />`);
            tableHtml.push(`    <line x1="${tableX + colWidths[0] + colWidths[1]}" y1="${rowY}" x2="${tableX + colWidths[0] + colWidths[1]}" y2="${rowY + rowHeight}" stroke="#e2e8f0" stroke-width="1" />`);
            tableHtml.push(`    <text x="${tableX + 12}" y="${rowY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="11.5" fill="#334155">${rows[r].input}</text>`);
            tableHtml.push(`    <text x="${tableX + colWidths[0] + 12}" y="${rowY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="11.5" fill="#334155">${rows[r].output}</text>`);
            tableHtml.push(`    <text x="${tableX + colWidths[0] + colWidths[1] + 12}" y="${rowY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="11.5" fill="#334155">${rows[r].defaultValue}</text>`);
            tableHtml.push(`  </g>`);
        }
        
        const legendY = Math.max(650, tableY + (rows.length + 2) * rowHeight + 20);
        const legendHtml = [
            `  <g class="legend" transform="translate(50, ${legendY})">`,
            `    <text x="0" y="0" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="#64748b" font-style="italic">${l('svg.legend.loopback')}</text>`,
            `  </g>`
        ];
        
        const svgWidth = 1300;
        const svgHeight = legendY + 40;
        
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">\n`;
        svg += `  <defs>\n`;
        svg += `    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">\n`;
        svg += `      <path d="M 1 2 L 9 5 L 1 8 L 3.5 5 z" fill="#334155" />\n`;
        svg += `    </marker>\n`;
        svg += `  </defs>\n`;
        
        if (!isNoBg) {
            svg += `  <rect width="100%" height="100%" fill="#ffffff" stroke="none" />\n`;
        }
        
        svg += `<!-- Transitions -->\n`;
        svg += transitionHtml.join('\n') + '\n\n';
        
        svg += `<!-- State Nodes -->\n`;
        svg += nodeHtml.join('\n') + '\n\n';
        
        svg += `<!-- I/O Table -->\n`;
        svg += tableHtml.join('\n') + '\n\n';
        
        svg += `<!-- Legend -->\n`;
        svg += legendHtml.join('\n') + '\n';
        
        svg += `</svg>`;
        
        return svg;
    }

    /**
     * Génère un diagramme Mermaid au format texte représentant l'entité ou sa machine à états (FSM).
     * Si aucune FSM n'est trouvée, génère un graphe simple d'entrées/sorties et multiplexeurs (RTL).
     * Sinon, génère un diagramme d'états (stateDiagram-v2).
     *
     * @returns {string} Le code source du diagramme Mermaid.
     */
    generateMermaid() {
        const ports = this.extractPorts();
        const fsms = this.extractFsms();

        const lines = [];
        if (fsms.length === 0) {
            // Pas de FSM : Génération d'un diagramme de ports d'entrées/sorties (RTL)
            lines.push("graph LR");
            const inputs = ports.filter(p => p.direction === 'in');
            const outputs = ports.filter(p => p.direction === 'out');

            lines.push("    subgraph Entity [RTL Schematic]");
            for (const i of inputs) {
                lines.push(`        IN_${i.name}([${i.name}])`);
            }
            for (const o of outputs) {
                lines.push(`        OUT_${o.name}[/${o.name}\\]`);
            }

            // Repérer les structures conditionnelles simples de type multiplexeur
            const ifRegex = /if\s+([\s\S]*?)\s+then/gi;
            let ifm;
            let muxIdx = 0;
            while ((ifm = ifRegex.exec(this.cleanContent)) !== null) {
                let cond = ifm[1].trim().replace(/"/g, "'");
                if (!cond.includes("rising_edge") && !cond.includes("falling_edge") && !cond.toLowerCase().includes("rst") && !cond.toLowerCase().includes("clk")) {
                    lines.push(`        MUX_${muxIdx}{ ${cond} }`);
                    muxIdx += 1;
                }
            }
            lines.push("    end");
        } else {
            // Génération d'un diagramme d'états FSM Mermaid
            lines.push("stateDiagram-v2");
            for (const fsm of fsms) {
                for (const [stateName, st] of Object.entries(fsm.stateDetails)) {
                    let desc = stateName;
                    if (Object.keys(st.outputs).length > 0) {
                        const outs = Object.entries(st.outputs).map(([k, v]) => `${k} = ${v}`).join("<br/>");
                        desc = `${stateName}<br/><hr/>${outs}`;
                    }
                    lines.push(`    ${stateName} : ${desc}`);
                }

                for (const [stateName, st] of Object.entries(fsm.stateDetails)) {
                    for (const t of st.transitions) {
                        const toState = t.to;
                        if (fsm.states.includes(toState)) {
                            let cond = t.cond;
                            cond = cond.replace(/"/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                            if (cond === 'default') {
                                lines.push(`    ${stateName} --> ${toState}`);
                            } else {
                                lines.push(`    ${stateName} --> ${toState} : ${cond}`);
                            }
                        }
                    }
                }
            }
        }

        return lines.join("\n");
    }
}

/**
 * Lit un fichier VHDL et extrait son diagramme Mermaid de haut niveau.
 *
 * @param {string} filePath - Chemin absolu du fichier VHDL.
 * @returns {string} Le code source Mermaid.
 */
function processFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const extractor = new RtlExtractor(content);
    return extractor.generateMermaid();
}

module.exports = {
    RtlExtractor,
    processFile
};
