/**
 * @file vcd_parser.js
 * @brief Analyseur VCD (Value Change Dump) pour l'inspection des formes d'ondes VHDL / GHDL.
 * Permet d'extraire les signaux, la base de temps et les transitions de valeurs
 * pour inspection par les assistants IA ou l'interface utilisateur.
 */

const fs = require('fs');

/**
 * Analyse le contenu textuel d'un fichier VCD.
 *
 * @param {string} content - Le contenu brut du fichier VCD.
 * @returns {Object} Un objet contenant timescale, signals, et transitions par horodatage.
 */
function parseVcdContent(content) {
    const lines = content.split(/\r?\n/);
    let timescale = '1ns';
    const varMap = new Map(); // id -> { name, type, size, scope }
    const scopeStack = [];
    const timeline = []; // [ { time: number, changes: { [name]: string } } ]
    let currentTime = 0;
    let currentChanges = {};
    let inHeader = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (inHeader) {
            if (line.startsWith('$timescale')) {
                const tsMatch = /\$timescale\s+([^\$]+)\s+\$end/i.exec(line);
                if (tsMatch) {
                    timescale = tsMatch[1].trim();
                } else if (i + 1 < lines.length) {
                    timescale = lines[i + 1].replace(/\$end/g, '').trim();
                }
            } else if (line.startsWith('$scope')) {
                const scopeParts = line.split(/\s+/);
                if (scopeParts.length >= 3) {
                    scopeStack.push(scopeParts[2]);
                }
            } else if (line.startsWith('$upscope')) {
                scopeStack.pop();
            } else if (line.startsWith('$var')) {
                // $var <type> <size> <id> <name> [$end]
                const match = /\$var\s+(\w+)\s+(\d+)\s+(\S+)\s+([^\[\s\$]+)(?:\[[^\]]+\])?\s*(?:\$end)?/i.exec(line);
                if (match) {
                    const [, type, size, id, name] = match;
                    const fullScope = scopeStack.join('.');
                    const fullName = fullScope ? `${fullScope}.${name}` : name;
                    varMap.set(id, {
                        id,
                        name: fullName,
                        shortName: name,
                        type,
                        size: parseInt(size, 10),
                        scope: fullScope
                    });
                }
            } else if (line.startsWith('$enddefinitions')) {
                inHeader = false;
            }
            continue;
        }

        // Section données / changements de valeurs
        if (line.startsWith('#')) {
            const newTime = parseInt(line.substring(1).trim(), 10);
            if (Object.keys(currentChanges).length > 0) {
                timeline.push({ time: currentTime, changes: currentChanges });
                currentChanges = {};
            }
            currentTime = newTime;
        } else if (line.startsWith('$dumpvars') || line.startsWith('$end')) {
            continue;
        } else if (line.startsWith('b') || line.startsWith('B') || line.startsWith('r') || line.startsWith('R')) {
            // Vecteur : b0101 !
            const spaceIdx = line.indexOf(' ');
            if (spaceIdx !== -1) {
                const val = line.substring(1, spaceIdx).trim();
                const id = line.substring(spaceIdx + 1).trim();
                const varInfo = varMap.get(id);
                if (varInfo) {
                    currentChanges[varInfo.name] = val;
                }
            }
        } else {
            // Scalaire : 0! ou 1! ou x!
            const val = line[0];
            const id = line.substring(1).trim();
            const varInfo = varMap.get(id);
            if (varInfo) {
                currentChanges[varInfo.name] = val;
            }
        }
    }

    if (Object.keys(currentChanges).length > 0) {
        timeline.push({ time: currentTime, changes: currentChanges });
    }

    return {
        timescale,
        signals: Array.from(varMap.values()),
        timeline
    };
}

/**
 * Interroge les transitions d'ondes VCD pour des signaux et une fenêtre temporelle donnée.
 *
 * @param {string} vcdFilePath - Chemin du fichier VCD.
 * @param {Object} [queryOptions] - Options de filtrage (signals, timeStart, timeEnd, maxEvents).
 * @returns {Object} Résumé structuré de la forme d'onde.
 */
function queryVcdFile(vcdFilePath, queryOptions = {}) {
    if (!fs.existsSync(vcdFilePath)) {
        throw new Error(`VCD file not found: ${vcdFilePath}`);
    }

    const content = fs.readFileSync(vcdFilePath, 'utf8');
    const parsed = parseVcdContent(content);

    const timeStart = queryOptions.timeStart !== undefined ? Number(queryOptions.timeStart) : 0;
    const timeEnd = queryOptions.timeEnd !== undefined ? Number(queryOptions.timeEnd) : Infinity;
    const requestedSignals = Array.isArray(queryOptions.signals) && queryOptions.signals.length > 0
        ? queryOptions.signals.map(s => s.toLowerCase())
        : null;
    const maxEvents = queryOptions.maxEvents || 100;

    // Filtrer la liste des signaux
    const matchedSignals = parsed.signals.filter(s => {
        if (!requestedSignals) return true;
        const sName = s.name.toLowerCase();
        const sShort = s.shortName.toLowerCase();
        return requestedSignals.some(req => sName.includes(req) || sShort === req);
    });

    const signalNamesSet = new Set(matchedSignals.map(s => s.name));

    // Signaux et leurs dernières valeurs connues
    const currentValues = {};
    const filteredTimeline = [];

    for (const step of parsed.timeline) {
        if (step.time > timeEnd && filteredTimeline.length > 0) break;

        const relevantChanges = {};
        for (const [sig, val] of Object.entries(step.changes)) {
            currentValues[sig] = val;
            if (signalNamesSet.has(sig)) {
                relevantChanges[sig] = val;
            }
        }

        if (step.time >= timeStart && step.time <= timeEnd && Object.keys(relevantChanges).length > 0) {
            filteredTimeline.push({
                time: step.time,
                timestampStr: `${step.time} (${parsed.timescale})`,
                changes: relevantChanges
            });
            if (filteredTimeline.length >= maxEvents) {
                break;
            }
        }
    }

    return {
        timescale: parsed.timescale,
        totalSignals: parsed.signals.length,
        selectedSignals: matchedSignals.map(s => ({ name: s.name, type: s.type, size: s.size })),
        totalTimepoints: parsed.timeline.length,
        timeWindow: { timeStart, timeEnd },
        eventsCount: filteredTimeline.length,
        events: filteredTimeline
    };
}

module.exports = {
    parseVcdContent,
    queryVcdFile
};
