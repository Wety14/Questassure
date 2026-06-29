# Extension Questassure VHDL pour VS Code

[![Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Questassure-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=DARIER--LEGRAND.questassure-vscode)

L'extension officielle est disponible sur le [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DARIER--LEGRAND.questassure-vscode).

Cette extension intègre les outils de productivité VHDL de **Questassure** directement dans VS Code, offrant la coloration syntaxique, des diagnostics en temps réel, le formatage, des simulations, des schémas interactifs et un outil graphique de conception de FSM.

---

## 🚀 Installation & Prérequis

Pour utiliser cette extension, **GHDL**, **Yosys** et **Surfer** doivent être installés sur votre système.

### 1. macOS
Installez toutes les dépendances via Homebrew :
```bash
brew install ghdl yosys surfer
```

### 2. Linux
Installez via votre gestionnaire de paquets :
```bash
sudo apt update && sudo apt install ghdl yosys
cargo install surfer
```

### 3. Windows
1. Téléchargez et extrayez [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build) (regroupe GHDL et Yosys).
2. Téléchargez [Surfer](https://github.com/surfer-project/surfer/releases).
3. Ajoutez le dossier `bin` d'OSS CAD Suite et le dossier contenant `surfer.exe` à votre variable d'environnement `PATH` :
   - Appuyez sur la **touche Windows**, tapez `variables d'environnement` et sélectionnez **Modifier les variables d'environnement système**.
   - Cliquez sur **Variables d'environnement...**.
   - Sous *Variables utilisateur* ou *Variables système*, sélectionnez **Path** et cliquez sur **Modifier...**.
   - Cliquez sur **Nouveau** et ajoutez les chemins absolus des dossiers.
   - Cliquez sur **OK** sur toutes les fenêtres et redémarrez VS Code.

---

## ✨ Fonctionnalités clés

### 1. Édition intelligente & Formatage
* **Coloration syntaxique** : Thème personnalisé Questassure VHDL.
* **Sauvegarde automatique** : Sauvegarde après 1000 ms d'inactivité.
* **Diagnostics en direct** : Analyse syntaxique avec GHDL, vérificateur de liste de sensibilité et détecteur de verrous (latches).
* **Formatage du code** : Indentation à 4 espaces, alignement des colons et alignement conditionnel `<=` .

### 2. Outils visuels
* **Schémas RTL & Graphes FSM interactifs** : Rendu des portes logiques et diagrammes d'états à partir du code avec cross-probing bidirectionnel.
* **FSM Designer** : Concepteur visuel pour créer, éditer et sauvegarder graphiquement des FSM directement en code VHDL.
* **Visualiseur de chronogrammes intégré** : Panneau de chronogrammes SVG intégré avec presets de signaux.

### 3. Explorateur de tests & LSP
* **Explorateur de tests** : Détecte et lance les testbenches VHDL depuis le panneau de test natif de VS Code.
* **Navigation dans le code** : Aller à la définition (F12), Trouver les références (Shift+F12), Structure du document.
* **Générateurs de code** : Autocomplétion de port map, instanciation de composant (presse-papiers ou projet) et modèles de testbenches/FSM.

---

## ⚙️ Paramètres

* `questassure.ghdlPath` (défaut : `"ghdl"`) : Chemin vers l'exécutable GHDL.
* `questassure.stopTime` (défaut : `"1us"`) : Temps d'arrêt par défaut de la simulation.
* `questassure.language` (défaut : `"auto"`) : Langue de l'extension (`auto`, `en`, `fr`).
* `questassure.openWavesOnTestExplorerRun` (défaut : `true`) : Ouvrir automatiquement le chronogramme lors des tests.

---

## 🛠️ Installation via le Marketplace

* **Marketplace VS Code** : Recherchez **Questassure VHDL** et cliquez sur **Installer**.
* **Package VSIX** : Ouvrez la palette de commandes (`Ctrl+Shift+P`), sélectionnez **Extensions: Install from VSIX...** et choisissez le fichier `.vsix`.

---

## 📜 Crédits & Prérequis matériels/logiciels

* **GHDL** : Requiert une installation système et la présence de l'exécutable dans le `PATH` (ou configuré).
* **Yosys** : Requiert une installation système et la présence de l'exécutable dans le `PATH`.
* **Surfer** : Requiert une installation système et la présence de l'exécutable dans le `PATH`.
