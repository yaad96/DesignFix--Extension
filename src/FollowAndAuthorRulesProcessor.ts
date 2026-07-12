import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs/promises'; // Use fs/promises for readFile
import * as path from 'path';
import { WebSocketConstants } from './WebSocketConstants';
//import { MessageProcessor } from './MessageProcessor';
import { Constants } from './Constants';
import * as fs1 from 'fs';
import { FileChangeManager } from './FileChangeManager';
import { writeToFile, convertToXML, findFileAndReadContent } from './utilites';

import { diffLines } from 'diff';
import { codeLensChangeEmitter } from './extension';

export interface DiffChunk {
    range: vscode.Range;
    newText: string;
    filePath: string;
    originalText: string;
    fullOriginalContent: string;
    startOffset: number;
    endOffset: number;
    // URI (as string) of the untitled modified document this chunk belongs to.
    // Used to scope the Accept/Reject CodeLenses to the correct diff tab when a
    // multi-file fix opens several diff views at once.
    modifiedUri?: string;
}
export const diffChunks: DiffChunk[] = [];



interface Tag {
    ID: string;
    tagName: string;
    detail: string;
}



export class FollowAndAuthorRulesProcessor {
    private static instance: FollowAndAuthorRulesProcessor | null = null;
    private ws: WebSocket | null;
    private ruleTable: any[]; // Consider using a more specific type
    private tagTable: Tag[];
    private currentProjectPath: string;
    private originalDiffDecoration: vscode.TextEditorDecorationType | null = null;
    private modifiedDiffDecoration: vscode.TextEditorDecorationType | null = null;
    private originalDiffEditor: vscode.TextEditor | null = null;
    private modifiedDiffEditor: vscode.TextEditor | null = null;
    public readonly wsMessages: string[] = [
        WebSocketConstants.RECEIVE_EDIT_FIX,
        WebSocketConstants.SEND_CONTENT_FOR_EDIT_FIX,
        WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT,
        WebSocketConstants.RECEIVE_CONVERTED_JAVA_SNIPPET_MSG,
        WebSocketConstants.RECEIVE_LLM_SNIPPET_MSG,
        WebSocketConstants.RECEIVE_SNIPPET_XML_MSG,
        WebSocketConstants.RECEIVE_MODIFIED_RULE_MSG,
        WebSocketConstants.RECEIVE_MODIFIED_TAG_MSG,
        WebSocketConstants.RECEIVE_CODE_TO_XML_MSG,
        WebSocketConstants.RECEIVE_NEW_RULE_MSG,
        WebSocketConstants.RECEIVE_NEW_TAG_MSG,
    ];

    public constructor(currentProjectPath: string, ws: WebSocket | null) {
        this.currentProjectPath = currentProjectPath;
        this.ws = ws;
        this.tagTable = [];
        this.ruleTable = []; // Initialize as an empty array
        this.loadTagTable();
        this.loadRuleTable();
    }

    public static getInstance(currentProjectPath: string = "", ws: WebSocket | null = null): FollowAndAuthorRulesProcessor {
        if (this.instance === null) {
            this.instance = new FollowAndAuthorRulesProcessor(currentProjectPath, ws);
        }
        return this.instance;
    }

    private async loadTagTable(): Promise<void> {
        const tagTablePath = path.join(this.currentProjectPath, Constants.TAG_TABLE_JSON);
        try {
            const data = await fs.readFile(tagTablePath, { encoding: 'utf8' });
            this.tagTable = JSON.parse(data);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err?.code === 'ENOENT') {
                this.tagTable = [];
                try {
                    await fs.writeFile(tagTablePath, JSON.stringify(this.tagTable, null, 2), { encoding: 'utf8' });
                    console.warn(`Tag table not found. Created default at ${tagTablePath}`);
                } catch (writeError) {
                    console.error('Failed to create default tag table:', writeError);
                }
            } else {
                console.error('Failed to load tag table:', error);
            }
        }
    }

    private async loadRuleTable(): Promise<void> {
        const ruleTablePath = path.join(this.currentProjectPath, Constants.RULE_TABLE_JSON);
        try {
            const data = await fs.readFile(ruleTablePath, { encoding: 'utf8' });
            this.ruleTable = JSON.parse(data);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err?.code === 'ENOENT') {
                this.ruleTable = [];
                try {
                    await fs.writeFile(ruleTablePath, JSON.stringify(this.ruleTable, null, 2), { encoding: 'utf8' });
                    console.warn(`Rule table not found. Created default at ${ruleTablePath}`);
                } catch (writeError) {
                    console.error('Failed to create default rule table:', writeError);
                }
            } else {
                console.error('Failed to load rule table:', error);
            }
        }
    }

    public updateProjectWs(projectPath: string, ws: WebSocket): void {
        this.currentProjectPath = projectPath;
        this.ws = ws;
        this.loadTagTable();
        this.loadRuleTable();
    }

    private clearDiffDecorationsInternal(): void {
        if (this.originalDiffDecoration && this.originalDiffEditor) {
            try {
                this.originalDiffEditor.setDecorations(this.originalDiffDecoration, []);
            } catch (error) {
                console.warn('Failed to clear original diff decoration:', error);
            }
            this.originalDiffDecoration.dispose();
        }

        if (this.modifiedDiffDecoration && this.modifiedDiffEditor) {
            try {
                this.modifiedDiffEditor.setDecorations(this.modifiedDiffDecoration, []);
            } catch (error) {
                console.warn('Failed to clear modified diff decoration:', error);
            }
            this.modifiedDiffDecoration.dispose();
        }

        this.originalDiffDecoration = null;
        this.modifiedDiffDecoration = null;
        this.originalDiffEditor = null;
        this.modifiedDiffEditor = null;
    }

    public clearDiffDecorations(): void {
        this.clearDiffDecorationsInternal();
    }

    private normalizeNewlines(text: string): string {
        return text.replace(/\r\n/g, '\n');
    }

    private denormalizeNewlines(text: string, lineEnding: string): string {
        if (lineEnding === '\n') {
            return text.replace(/\r\n/g, '\n');
        }
        return this.normalizeNewlines(text).replace(/\n/g, lineEnding);
    }

    private computeActualOffset(sourceNormalized: string, normalizedIndex: number, lineEnding: string): number {
        const prefix = sourceNormalized.slice(0, normalizedIndex);
        return this.denormalizeNewlines(prefix, lineEnding).length;
    }

    private escapeRegExp(input: string): string {
        return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private buildFlexiblePattern(snippet: string): string {
        const escaped = this.escapeRegExp(snippet);
        return escaped.replace(/\s+/g, '\\s+');
    }

    public getRuleTableForClient(): string {
        const ruleTableData = JSON.stringify(this.ruleTable);
        return ruleTableData;
    }

    public getTagTableForClient(): string {
        const tagTableData = JSON.stringify(this.tagTable);
        return tagTableData;
    }




    public async processReceivedMessages(message: string): Promise<void> {
        const jsonData = JSON.parse(message.toString());
        const command = jsonData.command;

        switch (command) {

            case WebSocketConstants.RECEIVE_EDIT_FIX:
                //console.log("ASDASDASDasdadad22222");
                //console.log(jsonData);
                const filePathOfSuggestedFix = jsonData.data.filePathOfSuggestedFix;

                findFileAndReadContent(filePathOfSuggestedFix)
                    .then(content => {
                        if (content) {
                            // Process the file content as needed
                            console.log('File content:', content);

                            this.ws?.send(JSON.stringify({
                                command: WebSocketConstants.SEND_CONTENT_FOR_EDIT_FIX,
                                data: content
                            }));
                        }
                    })
                    .catch(err => {
                        console.error('Error reading file content:', err);
                    });

                break;


            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT: {
                await this.handleLlmModifiedFileContent(jsonData);
                break;
            }





            /*
            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT:
                console.log("COME");
                console.log(jsonData);

                // 1) Extract incoming fields
                var localFilePath = jsonData.data.filePath as string;
                var modifiedContent = jsonData.data.modifiedFileContent as string;
                var violatedCode = jsonData.data.violatedCode as string;
                // (explanation available if you want to inject as a comment)

                // 2) Helper to escape RegExp metachars
                var escapeRegExp = (s: string) =>
                    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // 3) Read the original file off disk
                fs1.readFile(localFilePath, 'utf8', (err, originalContent) => {
                    if (err) {
                        console.error('Error reading the file:', err);
                        return;
                    }

                    // 4) Produce the “fixed” content
                    const regex = new RegExp(escapeRegExp(violatedCode), 'gs');
                    const finalContent = originalContent.replace(regex, modifiedContent);

                    // 5) Show the real file side-by-side in Column 1
                    vscode.workspace.openTextDocument(localFilePath)
                        .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.One),
                            openErr => console.error(openErr));

                    // 6) Prepare your yellow highlight decoration
                    const highlightDeco = vscode.window.createTextEditorDecorationType({
                        backgroundColor: 'rgba(255,255,0,0.4)'
                    });

                    // 7) Clear out any old diffs
                    diffChunks.length = 0;

                    // 8) Open an unsaved Java doc with the new content in Column 2
                    vscode.workspace.openTextDocument({ language: 'java', content: finalContent })
                        .then(newDoc =>
                            vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Two)
                                .then(editor => {
                                    // 9) Compute a char-level diff
                                    const diffs = diffChars(originalContent, finalContent);
                                    let offset = 0;
                                    const decorations: vscode.DecorationOptions[] = [];

                                    for (const part of diffs) {
                                        if (!part.removed) {
                                            const len = part.value.length;
                                            if (part.added) {
                                                const start = newDoc.positionAt(offset);
                                                const end = newDoc.positionAt(offset + len);

                                                // 10) Highlight the added range
                                                decorations.push({ range: new vscode.Range(start, end) });

                                                // 11) Record this chunk (with exact offsets)
                                                const startOffset = newDoc.offsetAt(start);
                                                const endOffset = newDoc.offsetAt(end);
                                                // …after you do:
                                                // fs1.readFile(localFilePath, 'utf8', (err, originalContent) => { … })
                                                const fullOriginalContent = originalContent;

                                                // then, when you push each diff:
                                                diffChunks.push({
                                                    range: new vscode.Range(start, end),
                                                    newText: part.value,
                                                    originalText: violatedCode,
                                                    fullOriginalContent:fullOriginalContent,          // ← add this
                                                    filePath: localFilePath,
                                                    startOffset,
                                                    endOffset
                                                });

                                            }
                                            offset += len;
                                        }
                                    }

                                    // 12) Apply highlights and refresh CodeLenses
                                    editor.setDecorations(highlightDeco, decorations);
                                    vscode.commands.executeCommand('editor.action.codeLens.refresh');
                                },
                                    showErr => console.error(showErr)
                                ),
                            docErr => console.error(docErr)
                        );
                });
                break;
            */



            /*
            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT:
                console.log("COME");
                console.log(jsonData);

                var localFilePath = jsonData.data.filePath as string;
                var modifiedContent = jsonData.data.modifiedFileContent as string;
                var violatedCode = jsonData.data.violatedCode as string;
                // (explanation is available if you want to inject it as a comment)

                // 1) Read original file
                fs1.readFile(localFilePath, 'utf8', (err, originalContent) => {
                    if (err) {
                        console.error('Error reading the file:', err);
                        return;
                    }

                    // 2) Replace the violated snippet
                    var escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(escapeRegExp(violatedCode), 'gs');
                    const finalContent = originalContent.replace(regex, modifiedContent);

                    // 3) Open the original on Column One
                    vscode.workspace.openTextDocument(localFilePath)
                        .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.One),
                            openErr => console.error(openErr));

                    // 4) Create a decoration type for highlighting diffs
                    const highlightDeco = vscode.window.createTextEditorDecorationType({
                        backgroundColor: 'rgba(255,255,0,0.4)'
                    });

                    // 5) Open an untitled Java doc with the edited content on Column Two
                    vscode.workspace.openTextDocument({ language: 'java', content: finalContent })
                        .then(newDoc =>
                            vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Two)
                                .then(editor => {
                                    // 6) Compute the diff between original vs. final
                                    const diffs = diffChars(originalContent, finalContent);

                                    // 7) Walk the diff to collect ranges of *added* or *changed* text
                                    const decorations: vscode.DecorationOptions[] = [];
                                    let offset = 0;
                                    for (const part of diffs) {
                                        if (!part.removed) {
                                            const length = part.value.length;
                                            if (part.added) {
                                                const start = newDoc.positionAt(offset);
                                                const end = newDoc.positionAt(offset + length);
                                                decorations.push({ range: new vscode.Range(start, end) });
                                            }
                                            offset += length;
                                        }
                                    }

                                    // 8) Apply the highlighting on Column Two
                                    editor.setDecorations(highlightDeco, decorations);
                                },
                                    showErr => console.error(showErr)
                                ),
                            docErr => console.error(docErr)
                        );
                });
                break;
            */





            // Within your switch/case block:
            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT_backup: {
                await this.handleLlmModifiedFileContent(jsonData);
                break;
            }


            /*
                        case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT:
            
                            //modifiedFileContent is just the suggestion from GPT, not the whole codefile with the modifications. 
                            //JUST THE MODIFICATIONS
                            console.log("COME");
                            console.log(jsonData);
                            const localFilePath = jsonData.data.filePath;
                            const modifiedContent = jsonData.data.modifiedFileContent;
                            const explanation = jsonData.data.explanation;
                            const violatedCode = jsonData.data.violatedCode;
            
                            // Function to escape special characters in a string for use in a regular expression
                            const escapeRegExp = (string: string): string => {
                                return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
                            };
            
                            // Read the file content
                            fs1.readFile(localFilePath, 'utf8', (err, data) => {
                                if (err) {
                                    console.error('Error reading the file:', err);
                                    return;
                                }
            
                                // Escape the violatedCode for use in a regular expression
                                const escapedViolatedCode = escapeRegExp(violatedCode);
            
                                // Create a regular expression to find the violated code, with the 's' flag for dotAll mode
                                const regex = new RegExp(escapedViolatedCode, 'gs');
            
                                // Replace the violated code with the modified content
                                const newContent = data.replace(regex, modifiedContent);
            
                                // Format the explanation as a comment
                                
                                const comment = ``;
            
                                // Prepare the final content with the explanation
                                const finalContent = `${comment}${newContent}`;
            
                                // Write the updated content back to the file
                                fs1.writeFile(localFilePath, finalContent, 'utf8', (err) => {
                                    if (err) {
                                        console.error('Error writing to the file:', err);
                                    } else {
                                        console.log('File updated successfully.');
                                    }
                                });
                            });
                            break;
                        */


            case WebSocketConstants.RECEIVE_CONVERTED_JAVA_SNIPPET_MSG:
                console.log("ASDAD222aaaa");
                try {
                    //const data = JSON.parse(message);
                    const fileName = jsonData.data.fileName;
                    const convertedJava = jsonData.data.convertedJava;
                    const lastLineSnippet = convertedJava.trim().split('\n').pop().trim();

                    const openPath = vscode.Uri.file(fileName);
                    vscode.workspace.openTextDocument(openPath).then(doc => {
                        vscode.window.showTextDocument(doc).then(editor => {
                            const text = doc.getText();
                            const lines = text.split('\n');
                            let lineIndex = -1;

                            // Find the line containing the lastLineSnippet
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].includes(lastLineSnippet)) {
                                    lineIndex = i;
                                    break;
                                }
                            }

                            if (lineIndex !== -1) {
                                const startPos = new vscode.Position(lineIndex, 0);
                                const endPos = new vscode.Position(lineIndex, lines[lineIndex].length);
                                const range = new vscode.Range(startPos, endPos);

                                editor.selection = new vscode.Selection(startPos, endPos);
                                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

                                // Optionally highlight the line
                                const decoration = vscode.window.createTextEditorDecorationType({
                                    backgroundColor: 'rgba(255,255,0,0.3)'
                                });
                                editor.setDecorations(decoration, [range]);
                            }
                        });
                    });
                } catch (error) {
                    vscode.window.showErrorMessage('Failed to process the message: ' + error);
                }
                break;

            case WebSocketConstants.RECEIVE_LLM_SNIPPET_MSG:
                console.log("CAME HERE");
                const code = jsonData.data.code;
                // Format the explanation as a multiline comment
                const explanationAsComment = `/*\n * ${jsonData.data.explanation.replace(/\n/g, '\n * ')}\n */\n\n`;

                // Create a new split window with the explanation comment at the top and the code below
                vscode.workspace.openTextDocument({ content: explanationAsComment + code, language: 'java' }) // Adjust the language as necessary
                    .then(document => {
                        vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                    });
                break;

            case WebSocketConstants.RECEIVE_SNIPPET_XML_MSG:
                // Handle RECEIVE_SNIPPET_XML_MSG
                /*const xmlString = jsonData.data.xml;


                const tempXmlFilePath = path.join(this.currentProjectPath, Constants.TEMP_XML_FILE);
                const xmlHeader = Constants.XML_HEADER;

                // Write XML to temporary file
                fs.writeFile(tempXmlFilePath, xmlHeader + xmlString, { encoding: 'utf8' });

                // Open the specified file
                //we are getting the full path from the client 
                const fileUri = vscode.Uri.file(jsonData.data.fileName);
                const document = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(document);

                try {
                    const positionString = await findLineNumber(tempXmlFilePath);
                    // Calculate the position based on the XML length
                    const positionIndex = positionString.length;

                    // Find the position in the document
                    const charPosition = document.positionAt(positionIndex);

                    // Get the entire line where the character is located
                    const line = document.lineAt(charPosition.line);

                    // Use the start and end of the line for startPosition and endPosition
                    const startPosition = line.range.start;
                    const endPosition = line.range.end;

                    // Move the cursor and highlight the whole line
                    editor.selection = new vscode.Selection(startPosition, endPosition);
                    editor.revealRange(new vscode.Range(startPosition, endPosition), vscode.TextEditorRevealType.InCenter);
                } catch (error) {
                    console.error("An error occurred:");
                    console.error(error); // Handle the error
                }*/


                break;

            case WebSocketConstants.RECEIVE_MODIFIED_RULE_MSG:
                // Extract ruleID and ruleInfo from jsonData.data
                const ruleID = jsonData.data.ruleID;
                const ruleInfo = jsonData.data.ruleInfo;
                const ruleExists = this.checkRuleExists(ruleID, ruleInfo);
                if (ruleExists) {
                    const ruleIndex = this.ruleTable.findIndex(rule => rule.index === ruleID);
                    this.ruleTable[ruleIndex] = ruleInfo;
                    this.updateRuleTableFile();

                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_UPDATE_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }
                else {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_FAILED_UPDATE_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }

                }
                // Update the rule by ruleID with ruleInfo here
                break;
            case WebSocketConstants.RECEIVE_MODIFIED_TAG_MSG:
                // Extract tagID and tagInfo from jsonData.data
                const updateTagID = jsonData.data.tagID;
                const updateTagInfo = jsonData.data.tagInfo;
                var data = {
                    ID: jsonData.data.tagInfo.ID,
                    tagName: jsonData.data.tagInfo.tagName,
                    detail: jsonData.data.tagInfo.detail
                };
                // Update the tag by tagID with tagInfo here
                const tagExists = this.checkTagExists(updateTagID, updateTagInfo);
                if (tagExists) {
                    const tagIndex = this.tagTable.findIndex(tag => tag.ID === updateTagID);
                    this.tagTable[tagIndex] = updateTagInfo;
                    this.updateTagTableFile();

                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_UPDATE_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }
                else {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({

                            command: WebSocketConstants.SEND_FAILED_UPDATE_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }

                }

                break;
            case WebSocketConstants.RECEIVE_CODE_TO_XML_MSG:
                // Handle conversion of code to XML and respond back
                const plainCode = jsonData.data.codeText;
                const tempJavaFilePath = path.join(this.currentProjectPath, Constants.TEMP_JAVA_FILE);
                writeToFile(tempJavaFilePath, plainCode);
                if (tempJavaFilePath.endsWith('.java')) {


                    try {
                        const xmlContent = await convertToXML(tempJavaFilePath); // Adjusted call
                        if (this.ws?.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({
                                command: WebSocketConstants.SEND_XML_FROM_CODE_MSG,
                                data: {
                                    xmlText: xmlContent,
                                    messageID: jsonData.data.messageID
                                }
                            }));
                        } else {
                            console.warn('Skipping send: WebSocket not open');
                        }



                    } catch (error) {
                        console.error(`Error processing newly created file ${tempJavaFilePath}:`, error);
                    }
                }

                //const resultXML = FileChangeManager.getInstance(this.currentProjectPath,this.ws).convertToXML(tempJavaFilePath) 


                break;
            case WebSocketConstants.RECEIVE_NEW_RULE_MSG:
                // Handle new rule creation from jsonData.data
                const newRuleID = jsonData.data.ruleID;
                const newRuleInfo = jsonData.data.ruleInfo;

                const ruleAlreadyExists = this.checkRuleExists(newRuleID, newRuleInfo);
                if (ruleAlreadyExists) {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_FAILED_NEW_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }
                else {
                    //console.log("here");
                    this.ruleTable.push(newRuleInfo);
                    this.updateRuleTableFile();
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({

                            command: WebSocketConstants.SEND_NEW_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }

                break;
            case WebSocketConstants.RECEIVE_NEW_TAG_MSG:
                // Similar to the Java version, parse the jsonData for new tag info and process it
                const newTagID = jsonData.data.tagID;
                const newTagInfo = jsonData.data.tagInfo;
                data = {
                    ID: jsonData.data.tagInfo.ID,
                    tagName: jsonData.data.tagInfo.tagName,
                    detail: jsonData.data.tagInfo.detail
                };


                const tagAlreadyExists = this.checkTagExists(newTagID, newTagInfo);
                if (tagAlreadyExists) {


                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_FAILED_NEW_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }



                }
                else {
                    this.tagTable.push(newTagInfo);
                    this.updateTagTableFile();
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({

                            command: WebSocketConstants.SEND_NEW_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }

                }
                // Add a new tag based on newTagID and newTagInfo here
                break;
            // Add other case statements as necessary
            default:
                console.log(`Unrecognized command: ${command}`);
        }

    }

    private checkRuleExists(newRuleID: string, newRuleInfo: any): boolean {
        if (newRuleID !== newRuleInfo.index) {
            console.error("Mismatched IDs");
            return true;
        }

        const ruleExists = this.ruleTable.some(rule => rule.index === newRuleID);
        if (ruleExists) {
            return true;
        }
        return false;
    }

    private checkTagExists(newTagID: string, newTagInfo: Tag): boolean {


        // Ensure the ID in the newTagInfo matches newTagID
        if (newTagInfo.ID !== newTagID) {
            console.error("Mismatched IDs");
            return true;
        }

        // Check if the tagTable already contains a tag with the newTagID
        const tagExists = this.tagTable.some(tag => tag.ID === newTagID);
        if (tagExists) {
            // Tag already exists, return true
            return true;
        }
        return false;
    }


    private async updateRuleTableFile() {
        const ruleTablePath = path.join(this.currentProjectPath, Constants.RULE_TABLE_JSON); // Adjust __dirname to your project's root path as necessary

        // Read the existing tag table
        fs1.readFile(ruleTablePath, 'utf8', (err, data) => {
            if (err) {
                console.error('Error reading the file table:', err);
                return;
            }

            // Parse the existing tag table and append new tag info
            //const tagTable = JSON.parse(data);


            // Write the updated tag table back to the file
            fs1.writeFile(ruleTablePath, JSON.stringify(this.ruleTable, null, 2), 'utf8', (err) => {
                if (err) {
                    console.error('Error writing the updated rule table:', err);
                } else {
                    console.log('rule info successfully appended to tagTable.json');
                }
            });
        });
    }



    private async updateTagTableFile() {
        const tagTablePath = path.join(this.currentProjectPath, Constants.TAG_TABLE_JSON); // Adjust __dirname to your project's root path as necessary

        // Read the existing tag table
        fs1.readFile(tagTablePath, 'utf8', (err, data) => {
            if (err) {
                console.error('Error reading the tag table:', err);
                return;
            }

            // Parse the existing tag table and append new tag info
            //const tagTable = JSON.parse(data);


            // Write the updated tag table back to the file
            fs1.writeFile(tagTablePath, JSON.stringify(this.tagTable, null, 2), 'utf8', (err) => {
                if (err) {
                    console.error('Error writing the updated tag table:', err);
                } else {
                    console.log('Tag info successfully appended to tagTable.json');
                }
            });
        });
    }


    private applyDiffHighlights(
        originalEditor: vscode.TextEditor,
        modifiedEditor: vscode.TextEditor,
        normalizedOriginal: string,
        normalizedNew: string,
        lineEnding: string
    ): void {
        const diffs = diffLines(normalizedOriginal, normalizedNew);
        const addedRanges: vscode.DecorationOptions[] = [];
        const removedRanges: vscode.DecorationOptions[] = [];

        let originalOffset = 0;
        let newOffset = 0;

        for (const part of diffs) {
            const value = part.value ?? '';
            if (!value.length) {
                continue;
            }

            if (part.added) {
                const actualStart = this.computeActualOffset(normalizedNew, newOffset, lineEnding);
                const actualLength = this.denormalizeNewlines(value, lineEnding).length;
                const range = new vscode.Range(
                    modifiedEditor.document.positionAt(actualStart),
                    modifiedEditor.document.positionAt(actualStart + actualLength)
                );
                addedRanges.push({ range });
                newOffset += value.length;
                continue;
            }

            if (part.removed) {
                const actualStart = this.computeActualOffset(normalizedOriginal, originalOffset, lineEnding);
                const actualLength = this.denormalizeNewlines(value, lineEnding).length;
                const range = new vscode.Range(
                    originalEditor.document.positionAt(actualStart),
                    originalEditor.document.positionAt(actualStart + actualLength)
                );
                removedRanges.push({ range });
                originalOffset += value.length;
                continue;
            }

            originalOffset += value.length;
            newOffset += value.length;
        }

        const addedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(46, 160, 67, 0.35)'
        });
        const removedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(248, 81, 73, 0.35)'
        });

        modifiedEditor.setDecorations(addedDecoration, addedRanges);
        originalEditor.setDecorations(removedDecoration, removedRanges);

        this.modifiedDiffDecoration = addedDecoration;
        this.originalDiffDecoration = removedDecoration;
        this.modifiedDiffEditor = modifiedEditor;
        this.originalDiffEditor = originalEditor;
    }

    /**
     * Persist a fix-attempt record under <workspace-root>/data/rule_<id>/run_<NN>/.
     * The `data` folder sits alongside the DesignFix-Extension and DesignFix-client
     * folders and is git-ignored. Each run captures everything we know about the
     * attempt: metadata, token usage, prompts, raw responses, the list of files
     * the LLM inspected, and the original/modified content of every edited file.
     */
    private async writeFixLog(log: any): Promise<void> {
        // <root>/DesignFix-Extension/out -> up two levels -> workspace root.
        const dataRoot = path.join(__dirname, '..', '..', 'data');

        const sanitize = (s: string) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
        const ruleId = sanitize(log.ruleId !== undefined && log.ruleId !== null ? log.ruleId : 'unknown');
        const ruleDir = path.join(dataRoot, `rule_${ruleId}`);

        await fs.mkdir(ruleDir, { recursive: true });

        // Next run number: scan existing run_NN folders and increment.
        let nextRun = 1;
        try {
            const entries = await fs.readdir(ruleDir, { withFileTypes: true });
            const runNums = entries
                .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
                .map(e => parseInt(e.name.slice(4), 10))
                .filter(n => !isNaN(n));
            if (runNums.length > 0) {
                nextRun = Math.max(...runNums) + 1;
            }
        } catch { /* ruleDir just created / empty */ }

        const runDir = path.join(ruleDir, `run_${String(nextRun).padStart(2, '0')}`);
        await fs.mkdir(runDir, { recursive: true });

        const inspectedFiles: any[] = Array.isArray(log.inspectedFiles) ? log.inspectedFiles : [];
        const editedFiles: any[] = Array.isArray(log.editedFiles) ? log.editedFiles : [];

        // meta.json: everything except the bulky file bodies and prompts.
        const meta = {
            ruleId: log.ruleId,
            ruleTitle: log.ruleTitle ?? '',
            createdAt: log.createdAt ?? new Date().toISOString(),
            model: log.model ?? '',
            violationFilePath: log.violationFilePath ?? '',
            exampleFilePath: log.exampleFilePath ?? '',
            tokenUsage: log.tokenUsage ?? null,
            inspectedFiles: inspectedFiles.map(f => ({ filePath: f.filePath, reason: f.reason ?? '' })),
            editedFiles: editedFiles.map(f => ({ filePath: f.filePath })),
            explanation: log.explanation ?? '',
        };
        await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

        // Prompts and raw model responses.
        if (log.prompts) {
            if (log.prompts.A) { await fs.writeFile(path.join(runDir, 'prompt_A.txt'), String(log.prompts.A), 'utf8'); }
            if (log.prompts.B) { await fs.writeFile(path.join(runDir, 'prompt_B.txt'), String(log.prompts.B), 'utf8'); }
        }
        if (log.responses) {
            if (log.responses.A) { await fs.writeFile(path.join(runDir, 'response_A.txt'), String(log.responses.A), 'utf8'); }
            if (log.responses.B) { await fs.writeFile(path.join(runDir, 'response_B.json'), String(log.responses.B), 'utf8'); }
        }

        // Original + modified content of every edited file, in a subfolder.
        if (editedFiles.length > 0) {
            const editsDir = path.join(runDir, 'edited_files');
            await fs.mkdir(editsDir, { recursive: true });
            let idx = 0;
            for (const f of editedFiles) {
                idx++;
                const base = sanitize(path.basename(f.filePath || `file_${idx}`));
                const stem = `${String(idx).padStart(2, '0')}_${base}`;
                if (typeof f.originalFileContent === 'string') {
                    await fs.writeFile(path.join(editsDir, `${stem}.original`), f.originalFileContent, 'utf8');
                }
                if (typeof f.modifiedFileContent === 'string') {
                    await fs.writeFile(path.join(editsDir, `${stem}.modified`), f.modifiedFileContent, 'utf8');
                }
            }
        }

        console.log(`DesignFix fix log written: ${runDir}`);
        vscode.window.setStatusBarMessage(`DesignFix: logged fix to data/rule_${ruleId}/run_${String(nextRun).padStart(2, '0')}`, 4000);
    }

    private async handleLlmModifiedFileContent(jsonData: any): Promise<void> {
        const data = jsonData?.data;
        if (!data) {
            console.error('LLM modified file content missing data payload.');
            return;
        }

        // Persist a full record of this fix attempt (files inspected/edited,
        // prompts, responses, token usage) for the agentic-comparison dataset.
        if (data.log) {
            try {
                await this.writeFixLog(data.log);
            } catch (err) {
                console.error('Failed to write DesignFix fix log:', err);
            }
        }

        // Multi-file fix: the LLM changed two or more files (e.g. a cross-file
        // rule whose fix touches both the violation file and a registry file).
        // Apply each edit directly; the FileSystemWatcher then reconverts and
        // re-checks automatically, updating the web app.
        if (Array.isArray(data.edits) && data.edits.length >= 2) {
            await this.applyMultiFileEdits(data.edits, data.explanation);
            return;
        }

        let targetPath: string | undefined = data.filePath || data.fileToChange;
        if (!targetPath) {
            vscode.window.showErrorMessage('Unable to apply fix: no target file path provided.');
            return;
        }

        if (!path.isAbsolute(targetPath)) {
            targetPath = path.join(this.currentProjectPath, targetPath);
        }

        const newContentRaw: string = data.modifiedFileContent ?? '';
        const providedOriginalRaw: string = data.originalFileContent ?? '';
        const explanation: string = data.explanation ?? '';

        if (!newContentRaw.trim()) {
            vscode.window.showErrorMessage('LLM fix did not include replacement content.');
            return;
        }

        let fileContent: string;
        try {
            fileContent = await fs.readFile(targetPath, { encoding: 'utf8' });
        } catch (error) {
            console.error('Failed to read target file:', error);
            vscode.window.showErrorMessage(`Unable to read file: ${targetPath}`);
            return;
        }

        if (providedOriginalRaw && this.normalizeNewlines(providedOriginalRaw) !== this.normalizeNewlines(fileContent)) {
            console.warn('Provided original content does not match the current file on disk. Proceeding with on-disk version.');
        }

        const lineEnding = fileContent.includes('\r\n') ? '\r\n' : '\n';
        const normalizedOriginal = this.normalizeNewlines(fileContent);
        const normalizedNew = this.normalizeNewlines(newContentRaw);

        const originalDoc = await vscode.workspace.openTextDocument(targetPath);
        const originalEditor = await vscode.window.showTextDocument(originalDoc, vscode.ViewColumn.One);

        const newDoc = await vscode.workspace.openTextDocument({
            language: originalDoc.languageId || 'java',
            content: newContentRaw
        });
        const newEditor = await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });

        this.clearDiffDecorationsInternal();
        this.applyDiffHighlights(originalEditor, newEditor, normalizedOriginal, normalizedNew, lineEnding);

        diffChunks.length = 0;
        const lensRange = new vscode.Range(newDoc.positionAt(0), newDoc.positionAt(0));
        const newDocText = newDoc.getText();
        diffChunks.push({
            range: lensRange,
            newText: newDocText,
            originalText: originalDoc.getText(),
            fullOriginalContent: fileContent,
            filePath: targetPath,
            startOffset: 0,
            endOffset: newDocText.length,
            modifiedUri: newDoc.uri.toString()
        });

        codeLensChangeEmitter.fire();

        if (explanation) {
            vscode.window.setStatusBarMessage(`LLM explanation: ${explanation}`, 5000);
        }
    }

    /**
     * Apply a set of LLM file edits (multi-file cross-file fix). Each edit is
     * written to disk directly after an optional confirmation; the workspace
     * FileSystemWatcher then reconverts and re-checks the affected files.
     */
    private async applyMultiFileEdits(edits: any[], explanation?: string): Promise<void> {
        const resolved: { path: string; content: string }[] = [];
        for (const edit of edits) {
            let p: string | undefined = edit?.filePath || edit?.fileToChange;
            const content: string = edit?.modifiedFileContent ?? edit?.code ?? '';
            if (!p || !content.trim()) {
                console.warn('Skipping edit with missing path or content:', edit);
                continue;
            }
            if (!path.isAbsolute(p)) {
                p = path.join(this.currentProjectPath, p);
            }
            resolved.push({ path: p, content });
        }

        if (resolved.length === 0) {
            vscode.window.showErrorMessage('LLM fix contained no applicable file edits.');
            return;
        }

        // Show the same review UX as single-file fixes, but one diff per changed
        // file: original on the left, modified (untitled) on the right, each with
        // its own Accept Change / Reject Change CodeLenses. Nothing is written to
        // disk until the user accepts an individual file.
        this.clearDiffDecorationsInternal();
        diffChunks.length = 0;

        let opened = 0;
        const alreadySatisfied: string[] = [];
        for (const r of resolved) {
            let originalContent = '';
            let originalDoc: vscode.TextDocument | null = null;
            try {
                originalContent = await fs.readFile(r.path, { encoding: 'utf8' });
                originalDoc = await vscode.workspace.openTextDocument(r.path);
            } catch (err) {
                // File does not exist yet (fix creates a new file): no original pane.
                console.warn(`No existing file for ${r.path}; showing modified content only.`);
            }

            // If the file on disk already matches the LLM's proposed content, there
            // is nothing to review (e.g. the fix was applied on a previous run).
            // Skip it so we don't open an empty, un-highlighted diff.
            if (originalDoc && this.normalizeNewlines(originalContent) === this.normalizeNewlines(r.content)) {
                alreadySatisfied.push(path.basename(r.path));
                continue;
            }

            let originalEditor: vscode.TextEditor | undefined;
            if (originalDoc) {
                originalEditor = await vscode.window.showTextDocument(originalDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
            }

            const lineEnding = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const newDoc = await vscode.workspace.openTextDocument({
                language: (originalDoc && originalDoc.languageId) || 'java',
                content: r.content
            });
            const newEditor = await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });

            if (originalEditor) {
                this.applyDiffHighlights(
                    originalEditor,
                    newEditor,
                    this.normalizeNewlines(originalContent),
                    this.normalizeNewlines(r.content),
                    lineEnding
                );
            }

            const newDocText = newDoc.getText();
            diffChunks.push({
                range: new vscode.Range(newDoc.positionAt(0), newDoc.positionAt(0)),
                newText: newDocText,
                originalText: originalContent,
                fullOriginalContent: originalContent,
                filePath: r.path,
                startOffset: 0,
                endOffset: newDocText.length,
                modifiedUri: newDoc.uri.toString()
            });
            opened++;
        }

        codeLensChangeEmitter.fire();

        if (opened > 0) {
            vscode.window.showInformationMessage(
                `DesignFix suggested a fix across ${opened} file(s). Review each tab and Accept or Reject Change.`
            );
            if (explanation) {
                vscode.window.setStatusBarMessage(`LLM explanation: ${explanation}`, 5000);
            }
        }

        if (alreadySatisfied.length > 0) {
            vscode.window.showWarningMessage(
                `DesignFix: ${alreadySatisfied.length} file(s) already match the suggested fix on disk (nothing to apply): ${alreadySatisfied.join(', ')}.`
            );
        }

        if (opened === 0 && alreadySatisfied.length === 0) {
            vscode.window.showErrorMessage('DesignFix: no reviewable file edits were produced.');
        }
    }
}
