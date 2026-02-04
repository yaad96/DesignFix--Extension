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

    private async handleLlmModifiedFileContent(jsonData: any): Promise<void> {
        const data = jsonData?.data;
        if (!data) {
            console.error('LLM modified file content missing data payload.');
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
            endOffset: newDocText.length
        });

        codeLensChangeEmitter.fire();

        if (explanation) {
            vscode.window.setStatusBarMessage(`LLM explanation: ${explanation}`, 5000);
        }
    }

}
