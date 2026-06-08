import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let isEnabled = true;
let watcher: vscode.FileSystemWatcher | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Ghost Stage');
    outputChannel.appendLine('Ghost Stage extension activated!');
    console.log('Ghost Stage extension activated!');

    isEnabled = context.globalState.get<boolean>('ghostStageEnabled', true);
    outputChannel.appendLine(`Initial state: ${isEnabled ? 'enabled' : 'disabled'}`);

    context.subscriptions.push(
        vscode.commands.registerCommand('ghost-stage.enable', () => {
            isEnabled = true;
            context.globalState.update('ghostStageEnabled', true);
            setupWatchersForAllWorkspaces(context);
            vscode.window.showInformationMessage('Ghost Stage enabled - new files will be automatically staged');
            outputChannel.appendLine('Ghost Stage enabled by user command');
        }),

        vscode.commands.registerCommand('ghost-stage.disable', () => {
            isEnabled = false;
            context.globalState.update('ghostStageEnabled', false);
            disposeWatcher();
            vscode.window.showInformationMessage('Ghost Stage disabled - new files will not be automatically staged');
            outputChannel.appendLine('Ghost Stage disabled by user command');
        }),

        vscode.commands.registerCommand('ghost-stage.status', () => {
            const status = isEnabled ? 'enabled' : 'disabled';
            vscode.window.showInformationMessage(`Ghost Stage is currently ${status}`);
            outputChannel.appendLine(`Status requested: ${status}`);
        }),

        vscode.workspace.onDidChangeWorkspaceFolders(event => {
            outputChannel.appendLine('Workspace folders changed');
            event.removed.forEach(folder => {
                outputChannel.appendLine(`Workspace removed: ${folder.uri.fsPath}`);
            });
            event.added.forEach(folder => {
                outputChannel.appendLine(`Workspace added: ${folder.uri.fsPath}`);
                if (isEnabled) {
                    setupWatcherForWorkspace(context, folder.uri.fsPath);
                }
            });
        }),

        vscode.workspace.onDidSaveTextDocument(document => {
            if (isEnabled) {
                const filePath = document.fileName;
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

                if (workspaceFolder) {
                    const workspacePath = workspaceFolder.uri.fsPath;
                    outputChannel.appendLine(`File saved: ${filePath}`);
                    addFileToGit(filePath, workspacePath);
                } else {
                    outputChannel.appendLine(`Skipped saving: No workspace found for ${filePath}`);
                }
            }
        })
    );

    if (isEnabled) {
        setupWatchersForAllWorkspaces(context);
    }
}

function checkIfGitRepository(folderPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const gitDir = path.join(folderPath, '.git');
        fs.access(gitDir, fs.constants.F_OK, (err) => {
            if (err) {
                outputChannel.appendLine(`No .git directory found in ${folderPath}`);
                resolve(false);
                return;
            }

            exec('git rev-parse --is-inside-work-tree', { cwd: folderPath }, (error, stdout, stderr) => {
                if (error || stdout.trim() !== 'true') {
                    outputChannel.appendLine(`Not a Git repository: ${error?.message || stderr}`);
                    resolve(false);
                } else {
                    outputChannel.appendLine(`Git repository detected in ${folderPath}`);
                    resolve(true);
                }
            });
        });
    });
}

function setupWatchersForAllWorkspaces(context: vscode.ExtensionContext) {
    disposeWatcher();

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        outputChannel.appendLine('No workspace folders found');
        return;
    }

    vscode.workspace.workspaceFolders.forEach(folder => {
        setupWatcherForWorkspace(context, folder.uri.fsPath);
    });
}

function setupWatcherForWorkspace(context: vscode.ExtensionContext, workspaceFolder: string) {
    outputChannel.appendLine(`Setting up watcher for workspace: ${workspaceFolder}`);

    checkIfGitRepository(workspaceFolder).then(isGitRepo => {
        if (!isGitRepo) {
            outputChannel.appendLine(`Skipping watcher setup for non-Git repository: ${workspaceFolder}`);
            return;
        }

        try {
            const pattern = new vscode.RelativePattern(workspaceFolder, "**/*");
            const newWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, false);
            outputChannel.appendLine(`File watcher created for ${workspaceFolder}`);

            newWatcher.onDidCreate(uri => {
                if (isEnabled) {
                    outputChannel.appendLine(`File created: ${uri.fsPath}`);

                    const relativePath = path.relative(workspaceFolder, uri.fsPath);
                    if (relativePath.startsWith('.git')) {
                        outputChannel.appendLine(`Ignoring file in .git directory: ${uri.fsPath}`);
                        return;
                    }

                    vscode.workspace.fs.stat(uri).then(
                        (stat) => {
                            if (stat.type === vscode.FileType.File) {
                                addFileToGit(uri.fsPath, workspaceFolder);
                            } else {
                                outputChannel.appendLine(`Created item is not a file, ignoring: ${uri.fsPath}`);
                            }
                        },
                        (error) => {
                            outputChannel.appendLine(`Error checking file: ${error}`);
                        }
                    );
                }
            });

            if (!context.subscriptions.includes(newWatcher)) {
                context.subscriptions.push(newWatcher);
                outputChannel.appendLine(`Watcher added to subscriptions for ${workspaceFolder}`);
            }

            if (!watcher) {
                watcher = newWatcher;
            }

        } catch (e) {
            outputChannel.appendLine(`Error setting up file watcher for ${workspaceFolder}: ${e}`);
            console.error(`Error setting up file watcher for ${workspaceFolder}:`, e);
        }
    });
}

function disposeWatcher() {
    if (watcher) {
        watcher.dispose();
        watcher = undefined;
        outputChannel.appendLine('File watcher disposed');
    }
}

function addFileToGit(filePath: string, workspaceFolder: string) {
    outputChannel.appendLine(`Staging file: ${filePath}`);

    exec(`git rev-parse --show-toplevel`, { cwd: workspaceFolder }, (rootError, gitRoot, rootStderr) => {
        if (rootError) {
            outputChannel.appendLine(`Error finding Git root: ${rootStderr}`);
            return;
        }

        const gitRepoPath = gitRoot.trim();
        const relativePath = path.relative(gitRepoPath, filePath);

        outputChannel.appendLine(`Adding file to Git: ${relativePath}`);
        exec(`git add --ignore-errors "${relativePath}"`, { cwd: gitRepoPath }, (addError, addStdout, addStderr) => {
            if (addError) {
                outputChannel.appendLine(`Git add error: ${addStderr}`);
                return;
            }

            outputChannel.appendLine(`File staged successfully: ${relativePath}`);
            vscode.commands.executeCommand('git.refresh');
        });
    });
}

export function deactivate() {
    disposeWatcher();
    if (outputChannel) {
        outputChannel.appendLine('Ghost Stage extension deactivated');
        outputChannel.dispose();
    }
    console.log('Ghost Stage extension deactivated');
}