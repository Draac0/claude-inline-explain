/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from microsoft/vscode src/vscode-dts/vscode.proposed.editorInsets.d.ts.
// A proposed API: the extension must list "editorInsets" in package.json
// `enabledApiProposals`, and the editor must be started with
// `--enable-proposed-api <extension id>` (see README "How the popover works").
// https://github.com/microsoft/vscode/issues/85682

declare module 'vscode' {

	export interface WebviewEditorInset {
		readonly editor: TextEditor;
		readonly line: number;
		readonly height: number;
		readonly webview: Webview;
		readonly onDidDispose: Event<void>;
		dispose(): void;
	}

	export namespace window {
		export function createWebviewTextEditorInset(editor: TextEditor, line: number, height: number, options?: WebviewOptions): WebviewEditorInset;
	}
}
