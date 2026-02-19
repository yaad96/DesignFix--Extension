# DesignFix- Extension

Official VS Code extension for DesignFix
## About

DesignFix- Extension is a Java-focused development companion that keeps design constraints actionable inside VS Code. It streams project context in real time, coordinates rule verification, and provides AI-assisted fix review workflows with one-click apply or revert.


## Current Functionalities and Capabilities

### 1) Real-Time Workspace Sync

- Starts a WebSocket server on port `8887` when the extension activates
- Sends workspace project path and Java-focused project hierarchy to connected client services
- Converts Java files to XML and streams initial XML snapshots on connection

### 2) Continuous Java File Tracking

- Watches Java file create, delete, rename, and edit events
- Re-converts changed Java files to XML and sends update messages automatically
- Triggers per-file rule checks after XML updates
- Sends focused Java file updates when active editor changes
- Uses a debounce strategy (3 seconds) to reduce noisy update traffic during typing

### 3) Rule and Tag Management

- Loads `ruleTable.json` and `tagTable.json` from workspace root
- Creates missing rule/tag table files automatically
- Supports new rule and new tag creation
- Supports existing rule and tag updates
- Returns success/failure acknowledgements over WebSocket for rule/tag operations

### 4) AI Fix Review and Safe Apply/Revert Workflow

- Receives full-file AI modifications and opens side-by-side comparison views
- Highlights added/removed diff regions in the editors
- Shows AI explanation in VS Code status bar
- Provides inline CodeLens actions:
  - `Accept Change`: writes reviewed content to target file
  - `Reject Change`: restores full original file content

### 5) Snippet Workflows

- Opens generated Java snippets in a split editor with explanation comments
- Locates and highlights converted Java snippet locations in target files
- Supports request/response flow to fetch file content for edit-fix pipelines

### 6) Design Rule Mining Pipeline

- Command-triggered mining entry point from editor context (`Mine Rules`)
- Sends selected element metadata (path, offsets, line, token) for mining
- Captures and sends DOI signals (recent files and caret activity)
- Receives mining datasets/features/helper files (including append mode for large payloads)
- Runs SPMF-based mining algorithms and sends mined results back to connected client services

### 7) Code-to-XML Service Support

- Converts incoming code snippets/expressions to XML on demand
- Returns XML responses with correlation message IDs for client-side matching

## VS Code Commands

- `activedoc.mineRules`: requests design rule mining for selected element
- `activedoc.acceptChange`: applies AI-reviewed diff content to file
- `activedoc.rejectChange`: reverts to original file content
- `activedoc.helloWorld`: basic extension command

Note: command IDs currently use the `activedoc.*` namespace for protocol and backward compatibility.

## Requirements

- VS Code `^1.86.0`
- Node.js and npm (for development builds)
- `srcml` installed
- Java runtime installed (required for mining execution)
- `spmf.jar` available in workspace root (required for design rule mining runs)
- A compatible DesignFix client/service connected over WebSocket (`ws://localhost:8887`)

## Run in Development

1. Open this folder in VS Code.
2. Run `npm install`.
3. Run `npm run compile` (or `npm run watch`).
4. Press `F5` to launch the extension host.

## Install Packaged VSIX

1. Open VS Code.
2. Go to Extensions (`Ctrl+Shift+X`).
3. Select `...` -> `Install from VSIX...`.
4. Choose the `.vsix` package file and install.

## Developer Scripts

- `npm run compile`: TypeScript build
- `npm run watch`: TypeScript watch mode
- `npm run lint`: ESLint checks
- `npm run test`: extension test runner

## Maintainer Note

This extension is actively developed by Mainul Hossain as part of the DesignFix toolchain.
