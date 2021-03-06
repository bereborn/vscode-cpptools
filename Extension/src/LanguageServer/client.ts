/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import {
    LanguageClient, LanguageClientOptions, ServerOptions, NotificationType, TextDocumentIdentifier,
    RequestType, ErrorAction, CloseAction, DidOpenTextDocumentParams, Range, Position, DocumentFilter
} from 'vscode-languageclient';
import { SourceFileConfigurationItem, WorkspaceBrowseConfiguration, SourceFileConfiguration, Version } from 'vscode-cpptools';
import { Status, IntelliSenseStatus } from 'vscode-cpptools/out/testApi';
import * as util from '../common';
import * as configs from './configurations';
import { CppSettings, OtherSettings } from './settings';
import * as telemetry from '../telemetry';
import { PersistentState, PersistentFolderState } from './persistentState';
import { UI, getUI } from './ui';
import { ClientCollection } from './clientCollection';
import { createProtocolFilter } from './protocolFilter';
import { DataBinding } from './dataBinding';
import minimatch = require("minimatch");
import * as logger from '../logger';
import { updateLanguageConfigurations, registerCommands } from './extension';
import { SettingsTracker, getTracker } from './settingsTracker';
import { getTestHook, TestHook } from '../testHook';
import { getCustomConfigProviders, CustomConfigurationProvider1, isSameProviderExtensionId } from '../LanguageServer/customProviders';
import { ABTestSettings, getABTestSettings } from '../abTesting';
import * as fs from 'fs';
import * as os from 'os';
import * as refs from './references';
import * as nls from 'vscode-nls';
import { lookupString, localizedStringCount } from '../nativeStrings';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();
type LocalizeStringParams = util.LocalizeStringParams;

let ui: UI;
let timeStamp: number = 0;
const configProviderTimeout: number = 2000;

// Data shared by all clients.
let languageClient: LanguageClient;
let languageClientCrashedNeedsRestart: boolean = false;
const languageClientCrashTimes: number[] = [];
let clientCollection: ClientCollection;
let pendingTask: util.BlockingTask<any> | undefined;
let compilerDefaults: configs.CompilerDefaults;
let diagnosticsChannel: vscode.OutputChannel;
let outputChannel: vscode.OutputChannel;
let debugChannel: vscode.OutputChannel;
let diagnosticsCollection: vscode.DiagnosticCollection;
let workspaceDisposables: vscode.Disposable[] = [];
let workspaceReferences: refs.ReferencesManager;

export function disposeWorkspaceData(): void {
    workspaceDisposables.forEach((d) => d.dispose());
    workspaceDisposables = [];
}

function logTelemetry(notificationBody: TelemetryPayload): void {
    telemetry.logLanguageServerEvent(notificationBody.event, notificationBody.properties, notificationBody.metrics);
}

/**
 * listen for logging messages from the language server and print them to the Output window
 */
function setupOutputHandlers(): void {
    console.assert(languageClient !== undefined, "This method must not be called until this.languageClient is set in \"onReady\"");

    languageClient.onNotification(DebugProtocolNotification, (output) => {
        if (!debugChannel) {
            debugChannel = vscode.window.createOutputChannel(`${localize("c.cpp.debug.protocol", "C/C++ Debug Protocol")}`);
            workspaceDisposables.push(debugChannel);
        }
        debugChannel.appendLine("");
        debugChannel.appendLine("************************************************************************************************************************");
        debugChannel.append(`${output}`);
    });

    languageClient.onNotification(DebugLogNotification, logLocalized);
}

function log(output: string): void {
    if (!outputChannel) {
        outputChannel = logger.getOutputChannel();
        workspaceDisposables.push(outputChannel);
    }
    outputChannel.appendLine(`${output}`);
}

function logLocalized(params: LocalizeStringParams): void {
    const output: string = util.getLocalizedString(params);
    log(output);
}

function showMessageWindow(params: ShowMessageWindowParams): void {
    const message: string = util.getLocalizedString(params.localizeStringParams);
    switch (params.type) {
        case 1: // Error
            vscode.window.showErrorMessage(message);
            break;
        case 2: // Warning
            vscode.window.showWarningMessage(message);
            break;
        case 3: // Info
            vscode.window.showInformationMessage(message);
            break;
        default:
            console.assert("Unrecognized type for showMessageWindow");
            break;
    }
}

function publishDiagnostics(params: PublishDiagnosticsParams): void {
    if (!diagnosticsCollection) {
        diagnosticsCollection = vscode.languages.createDiagnosticCollection("C/C++");
    }

    // Convert from our Diagnostic objects to vscode Diagnostic objects
    const diagnostics: vscode.Diagnostic[] = [];
    params.diagnostics.forEach((d) => {
        const message: string = util.getLocalizedString(d.localizeStringParams);
        const r: vscode.Range = new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character);
        const diagnostic: vscode.Diagnostic = new vscode.Diagnostic(r, message, d.severity);
        diagnostic.code = d.code;
        diagnostic.source = d.source;
        diagnostics.push(diagnostic);
    });

    const realUri: vscode.Uri = vscode.Uri.parse(params.uri);
    diagnosticsCollection.set(realUri, diagnostics);
}

interface WorkspaceFolderParams {
    workspaceFolderUri?: string;
}

interface TelemetryPayload {
    event: string;
    properties?: { [key: string]: string };
    metrics?: { [key: string]: number };
}

interface DebugProtocolParams {
    jsonrpc: string;
    method: string;
    params?: any;
}

interface ReportStatusNotificationBody extends WorkspaceFolderParams {
    status: string;
}

interface QueryCompilerDefaultsParams {
}

interface CppPropertiesParams extends WorkspaceFolderParams {
    currentConfiguration: number;
    configurations: any[];
    isReady?: boolean;
}

interface FolderSelectedSettingParams extends WorkspaceFolderParams {
    currentConfiguration: number;
}

interface SwitchHeaderSourceParams extends WorkspaceFolderParams {
    switchHeaderSourceFileName: string;
}

interface FileChangedParams extends WorkspaceFolderParams {
    uri: string;
}

interface InputRegion {
    startLine: number;
    endLine: number;
}

interface DecorationRangesPair {
    decoration: vscode.TextEditorDecorationType;
    ranges: vscode.Range[];
}

interface InactiveRegionParams {
    uri: string;
    fileVersion: number;
    regions: InputRegion[];
}

// Need to convert vscode.Uri to a string before sending it to the language server.
interface SourceFileConfigurationItemAdapter {
    uri: string;
    configuration: SourceFileConfiguration;
}

interface CustomConfigurationParams extends WorkspaceFolderParams {
    configurationItems: SourceFileConfigurationItemAdapter[];
}

interface CustomBrowseConfigurationParams extends WorkspaceFolderParams {
    browseConfiguration: WorkspaceBrowseConfiguration;
}

interface CompileCommandsPaths extends WorkspaceFolderParams {
    paths: string[];
}

interface QueryTranslationUnitSourceParams extends WorkspaceFolderParams {
    uri: string;
}

interface QueryTranslationUnitSourceResult {
    candidates: string[];
}

interface GetDiagnosticsResult {
    diagnostics: string;
}

interface Diagnostic {
    range: Range;
    code?: number | string;
    source?: string;
    severity: vscode.DiagnosticSeverity;
    localizeStringParams: LocalizeStringParams;
}

interface PublishDiagnosticsParams {
    uri: string;
    diagnostics: Diagnostic[];
}

interface GetCodeActionsRequestParams {
    uri: string;
    range: Range;
}

interface CodeActionCommand {
    localizeStringParams: LocalizeStringParams;
    command: string;
    arguments?: any[];
}

interface ShowMessageWindowParams {
    type: number;
    localizeStringParams: LocalizeStringParams;
}

interface GetDocumentSymbolRequestParams {
    uri: string;
}

interface WorkspaceSymbolParams extends WorkspaceFolderParams {
    query: string;
}

interface LocalizeDocumentSymbol {
    name: string;
    detail: LocalizeStringParams;
    kind: vscode.SymbolKind;
    range: Range;
    selectionRange: Range;
    children: LocalizeDocumentSymbol[];
}

interface Location {
    uri: string;
    range: Range;
}

interface LocalizeSymbolInformation {
    name: string;
    kind: vscode.SymbolKind;
    location: Location;
    containerName: string;
    suffix: LocalizeStringParams;
}

export interface RenameParams {
    newName: string;
    position: Position;
    textDocument: TextDocumentIdentifier;
}

export interface FindAllReferencesParams {
    position: Position;
    textDocument: TextDocumentIdentifier;
}

interface DidChangeConfigurationParams extends WorkspaceFolderParams {
    settings: any;
}

interface GetFoldingRangesParams {
    uri: string;
    id: number;
}

enum FoldingRangeKind {
    None = 0,
    Comment = 1,
    Imports = 2,
    Region = 3
}

interface FoldingRange {
    kind: FoldingRangeKind;
    range: Range;
}

interface GetFoldingRangesResult {
    canceled: boolean;
    ranges: FoldingRange[];
}

interface AbortRequestParams {
    id: number;
}

interface GetSemanticTokensParams {
    uri: string;
    id: number;
}

interface SemanticToken {
    line: number;
    character: number;
    length: number;
    type: number;
    modifiers?: number;
}

interface GetSemanticTokensResult {
    fileVersion: number;
    canceled: boolean;
    tokens: SemanticToken[];
}

enum SemanticTokenTypes {
    // These are camelCase as the enum names are used directly as strings in our legend.
    macro = 0,
    enumMember = 1,
    variable = 2,
    parameter = 3,
    type = 4,
    referenceType = 5,
    valueType = 6,
    function = 7,
    member = 8,
    property = 9,
    cliProperty = 10,
    event = 11,
    genericType = 12,
    templateFunction = 13,
    templateType = 14,
    namespace = 15,
    label = 16,
    customLiteral = 17,
    numberLiteral = 18,
    stringLiteral = 19,
    operatorOverload = 20,
    memberOperatorOverload = 21,
    newOperator = 22
}

enum SemanticTokenModifiers {
    // These are camelCase as the enum names are used directly as strings in our legend.
    // eslint-disable-next-line no-bitwise
    static = (1 << 0),
    // eslint-disable-next-line no-bitwise
    global = (1 << 1),
    // eslint-disable-next-line no-bitwise
    local = (1 << 2)
}

// Requests
const QueryCompilerDefaultsRequest: RequestType<QueryCompilerDefaultsParams, configs.CompilerDefaults, void, void> = new RequestType<QueryCompilerDefaultsParams, configs.CompilerDefaults, void, void>('cpptools/queryCompilerDefaults');
const QueryTranslationUnitSourceRequest: RequestType<QueryTranslationUnitSourceParams, QueryTranslationUnitSourceResult, void, void> = new RequestType<QueryTranslationUnitSourceParams, QueryTranslationUnitSourceResult, void, void>('cpptools/queryTranslationUnitSource');
const SwitchHeaderSourceRequest: RequestType<SwitchHeaderSourceParams, string, void, void> = new RequestType<SwitchHeaderSourceParams, string, void, void>('cpptools/didSwitchHeaderSource');
const GetDiagnosticsRequest: RequestType<void, GetDiagnosticsResult, void, void> = new RequestType<void, GetDiagnosticsResult, void, void>('cpptools/getDiagnostics');
const GetCodeActionsRequest: RequestType<GetCodeActionsRequestParams, CodeActionCommand[], void, void> = new RequestType<GetCodeActionsRequestParams, CodeActionCommand[], void, void>('cpptools/getCodeActions');
const GetDocumentSymbolRequest: RequestType<GetDocumentSymbolRequestParams, LocalizeDocumentSymbol[], void, void> = new RequestType<GetDocumentSymbolRequestParams, LocalizeDocumentSymbol[], void, void>('cpptools/getDocumentSymbols');
const GetSymbolInfoRequest: RequestType<WorkspaceSymbolParams, LocalizeSymbolInformation[], void, void> = new RequestType<WorkspaceSymbolParams, LocalizeSymbolInformation[], void, void>('cpptools/getWorkspaceSymbols');
const GetFoldingRangesRequest: RequestType<GetFoldingRangesParams, GetFoldingRangesResult, void, void> = new RequestType<GetFoldingRangesParams, GetFoldingRangesResult, void, void>('cpptools/getFoldingRanges');
const GetSemanticTokensRequest: RequestType<GetSemanticTokensParams, GetSemanticTokensResult, void, void> = new RequestType<GetSemanticTokensParams, GetSemanticTokensResult, void, void>('cpptools/getSemanticTokens');

// Notifications to the server
const DidOpenNotification: NotificationType<DidOpenTextDocumentParams, void> = new NotificationType<DidOpenTextDocumentParams, void>('textDocument/didOpen');
const FileCreatedNotification: NotificationType<FileChangedParams, void> = new NotificationType<FileChangedParams, void>('cpptools/fileCreated');
const FileChangedNotification: NotificationType<FileChangedParams, void> = new NotificationType<FileChangedParams, void>('cpptools/fileChanged');
const FileDeletedNotification: NotificationType<FileChangedParams, void> = new NotificationType<FileChangedParams, void>('cpptools/fileDeleted');
const ResetDatabaseNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/resetDatabase');
const PauseParsingNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/pauseParsing');
const ResumeParsingNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/resumeParsing');
const ActiveDocumentChangeNotification: NotificationType<TextDocumentIdentifier, void> = new NotificationType<TextDocumentIdentifier, void>('cpptools/activeDocumentChange');
const TextEditorSelectionChangeNotification: NotificationType<Range, void> = new NotificationType<Range, void>('cpptools/textEditorSelectionChange');
const ChangeCppPropertiesNotification: NotificationType<CppPropertiesParams, void> = new NotificationType<CppPropertiesParams, void>('cpptools/didChangeCppProperties');
const ChangeCompileCommandsNotification: NotificationType<FileChangedParams, void> = new NotificationType<FileChangedParams, void>('cpptools/didChangeCompileCommands');
const ChangeSelectedSettingNotification: NotificationType<FolderSelectedSettingParams, void> = new NotificationType<FolderSelectedSettingParams, void>('cpptools/didChangeSelectedSetting');
const IntervalTimerNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/onIntervalTimer');
const CustomConfigurationNotification: NotificationType<CustomConfigurationParams, void> = new NotificationType<CustomConfigurationParams, void>('cpptools/didChangeCustomConfiguration');
const CustomBrowseConfigurationNotification: NotificationType<CustomBrowseConfigurationParams, void> = new NotificationType<CustomBrowseConfigurationParams, void>('cpptools/didChangeCustomBrowseConfiguration');
const ClearCustomConfigurationsNotification: NotificationType<WorkspaceFolderParams, void> = new NotificationType<WorkspaceFolderParams, void>('cpptools/clearCustomConfigurations');
const ClearCustomBrowseConfigurationNotification: NotificationType<WorkspaceFolderParams, void> = new NotificationType<WorkspaceFolderParams, void>('cpptools/clearCustomBrowseConfiguration');
const RescanFolderNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/rescanFolder');
const RequestReferencesNotification: NotificationType<boolean, void> = new NotificationType<boolean, void>('cpptools/requestReferences');
const CancelReferencesNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/cancelReferences');
const FinishedRequestCustomConfig: NotificationType<string, void> = new NotificationType<string, void>('cpptools/finishedRequestCustomConfig');
const FindAllReferencesNotification: NotificationType<FindAllReferencesParams, void> = new NotificationType<FindAllReferencesParams, void>('cpptools/findAllReferences');
const RenameNotification: NotificationType<RenameParams, void> = new NotificationType<RenameParams, void>('cpptools/rename');
const DidChangeSettingsNotification: NotificationType<DidChangeConfigurationParams, void> = new NotificationType<DidChangeConfigurationParams, void>('cpptools/didChangeSettings');
const AbortRequestNotification: NotificationType<AbortRequestParams, void> = new NotificationType<AbortRequestParams, void>('cpptools/abortRequest');

// Notifications from the server
const ReloadWindowNotification: NotificationType<void, void> = new NotificationType<void, void>('cpptools/reloadWindow');
const LogTelemetryNotification: NotificationType<TelemetryPayload, void> = new NotificationType<TelemetryPayload, void>('cpptools/logTelemetry');
const ReportTagParseStatusNotification: NotificationType<LocalizeStringParams, void> = new NotificationType<LocalizeStringParams, void>('cpptools/reportTagParseStatus');
const ReportStatusNotification: NotificationType<ReportStatusNotificationBody, void> = new NotificationType<ReportStatusNotificationBody, void>('cpptools/reportStatus');
const DebugProtocolNotification: NotificationType<DebugProtocolParams, void> = new NotificationType<DebugProtocolParams, void>('cpptools/debugProtocol');
const DebugLogNotification:  NotificationType<LocalizeStringParams, void> = new NotificationType<LocalizeStringParams, void>('cpptools/debugLog');
const InactiveRegionNotification:  NotificationType<InactiveRegionParams, void> = new NotificationType<InactiveRegionParams, void>('cpptools/inactiveRegions');
const CompileCommandsPathsNotification:  NotificationType<CompileCommandsPaths, void> = new NotificationType<CompileCommandsPaths, void>('cpptools/compileCommandsPaths');
const ReferencesNotification: NotificationType<refs.ReferencesResultMessage, void> = new NotificationType<refs.ReferencesResultMessage, void>('cpptools/references');
const ReportReferencesProgressNotification: NotificationType<refs.ReportReferencesProgressNotification, void> = new NotificationType<refs.ReportReferencesProgressNotification, void>('cpptools/reportReferencesProgress');
const RequestCustomConfig: NotificationType<string, void> = new NotificationType<string, void>('cpptools/requestCustomConfig');
const PublishDiagnosticsNotification: NotificationType<PublishDiagnosticsParams, void> = new NotificationType<PublishDiagnosticsParams, void>('cpptools/publishDiagnostics');
const ShowMessageWindowNotification: NotificationType<ShowMessageWindowParams, void> = new NotificationType<ShowMessageWindowParams, void>('cpptools/showMessageWindow');
const ReportTextDocumentLanguage: NotificationType<string, void> = new NotificationType<string, void>('cpptools/reportTextDocumentLanguage');

let failureMessageShown: boolean = false;

let referencesRequestPending: boolean = false;
let renamePending: boolean = false;
let renameRequestsPending: number = 0;
let referencesParams: RenameParams | FindAllReferencesParams | undefined;

interface ReferencesCancellationState {
    reject(): void;
    callback(): void;
}

const referencesPendingCancellations: ReferencesCancellationState[] = [];

let abortRequestId: number = 0;

class ClientModel {
    public isTagParsing: DataBinding<boolean>;
    public isUpdatingIntelliSense: DataBinding<boolean>;
    public referencesCommandMode: DataBinding<refs.ReferencesCommandMode>;
    public tagParserStatus: DataBinding<string>;
    public activeConfigName: DataBinding<string>;

    constructor() {
        this.isTagParsing = new DataBinding<boolean>(false);
        this.isUpdatingIntelliSense = new DataBinding<boolean>(false);
        this.referencesCommandMode = new DataBinding<refs.ReferencesCommandMode>(refs.ReferencesCommandMode.None);
        this.tagParserStatus = new DataBinding<string>("");
        this.activeConfigName = new DataBinding<string>("");
    }

    public activate(): void {
        this.isTagParsing.activate();
        this.isUpdatingIntelliSense.activate();
        this.referencesCommandMode.activate();
        this.tagParserStatus.activate();
        this.activeConfigName.activate();
    }

    public deactivate(): void {
        this.isTagParsing.deactivate();
        this.isUpdatingIntelliSense.deactivate();
        this.referencesCommandMode.deactivate();
        this.tagParserStatus.deactivate();
        this.activeConfigName.deactivate();
    }

    public dispose(): void {
        this.isTagParsing.dispose();
        this.isUpdatingIntelliSense.dispose();
        this.referencesCommandMode.dispose();
        this.tagParserStatus.dispose();
        this.activeConfigName.dispose();
    }
}

export interface Client {
    TagParsingChanged: vscode.Event<boolean>;
    IntelliSenseParsingChanged: vscode.Event<boolean>;
    ReferencesCommandModeChanged: vscode.Event<refs.ReferencesCommandMode>;
    TagParserStatusChanged: vscode.Event<string>;
    ActiveConfigChanged: vscode.Event<string>;
    RootPath: string;
    RootUri?: vscode.Uri;
    Name: string;
    TrackedDocuments: Set<vscode.TextDocument>;
    onDidChangeSettings(event: vscode.ConfigurationChangeEvent, isFirstClient: boolean): { [key: string]: string };
    onDidOpenTextDocument(document: vscode.TextDocument): void;
    onDidCloseTextDocument(document: vscode.TextDocument): void;
    onDidChangeVisibleTextEditors(editors: vscode.TextEditor[]): void;
    onDidChangeTextDocument(textDocumentChangeEvent: vscode.TextDocumentChangeEvent): void;
    onRegisterCustomConfigurationProvider(provider: CustomConfigurationProvider1): Thenable<void>;
    updateCustomConfigurations(requestingProvider?: CustomConfigurationProvider1): Thenable<void>;
    updateCustomBrowseConfiguration(requestingProvider?: CustomConfigurationProvider1): Thenable<void>;
    provideCustomConfiguration(docUri: vscode.Uri, requestFile?: string): Promise<void>;
    logDiagnostics(): Promise<void>;
    rescanFolder(): Promise<void>;
    toggleReferenceResultsView(): void;
    setCurrentConfigName(configurationName: string): Thenable<void>;
    getCurrentConfigName(): Thenable<string | undefined>;
    getCurrentConfigCustomVariable(variableName: string): Thenable<string>;
    getVcpkgInstalled(): Thenable<boolean>;
    getVcpkgEnabled(): Thenable<boolean>;
    getCurrentCompilerPathAndArgs(): Thenable<util.CompilerPathAndArgs | undefined>;
    getKnownCompilers(): Thenable<configs.KnownCompiler[] | undefined>;
    takeOwnership(document: vscode.TextDocument): void;
    queueTask<T>(task: () => Thenable<T>): Thenable<T>;
    requestWhenReady<T>(request: () => Thenable<T>): Thenable<T>;
    notifyWhenReady(notify: () => void): void;
    requestSwitchHeaderSource(rootPath: string, fileName: string): Thenable<string>;
    activeDocumentChanged(document: vscode.TextDocument): void;
    activate(): void;
    selectionChanged(selection: Range): void;
    resetDatabase(): void;
    deactivate(): void;
    pauseParsing(): void;
    resumeParsing(): void;
    handleConfigurationSelectCommand(): void;
    handleConfigurationProviderSelectCommand(): void;
    handleShowParsingCommands(): void;
    handleReferencesIcon(): void;
    handleConfigurationEditCommand(): void;
    handleConfigurationEditJSONCommand(): void;
    handleConfigurationEditUICommand(): void;
    handleAddToIncludePathCommand(path: string): void;
    onInterval(): void;
    dispose(): Thenable<void>;
    addFileAssociations(fileAssociations: string, is_c: boolean): void;
    sendDidChangeSettings(settings: any): void;
}

export function createClient(allClients: ClientCollection, workspaceFolder?: vscode.WorkspaceFolder): Client {
    return new DefaultClient(allClients, workspaceFolder);
}

export function createNullClient(): Client {
    return new NullClient();
}

class FoldingRangeProvider implements vscode.FoldingRangeProvider {
    private client: DefaultClient;
    constructor(client: DefaultClient) {
        this.client = client;
    }
    provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext,
        token: vscode.CancellationToken): Promise<vscode.FoldingRange[]> {
        const id: number = ++abortRequestId;
        const params: GetFoldingRangesParams = {
            id: id,
            uri: document.uri.toString()
        };
        return new Promise<vscode.FoldingRange[]>((resolve, reject) => {
            this.client.notifyWhenReady(() => {
                this.client.languageClient.sendRequest(GetFoldingRangesRequest, params)
                    .then((ranges) => {
                        if (ranges.canceled) {
                            reject();
                        } else {
                            const result: vscode.FoldingRange[] = [];
                            ranges.ranges.forEach((r) => {
                                const foldingRange: vscode.FoldingRange = {
                                    start: r.range.start.line,
                                    end: r.range.end.line
                                };
                                switch (r.kind) {
                                    case FoldingRangeKind.Comment:
                                        foldingRange.kind = vscode.FoldingRangeKind.Comment;
                                        break;
                                    case FoldingRangeKind.Imports:
                                        foldingRange.kind = vscode.FoldingRangeKind.Imports;
                                        break;
                                    case FoldingRangeKind.Region:
                                        foldingRange.kind = vscode.FoldingRangeKind.Region;
                                        break;
                                    default:
                                        break;
                                }
                                result.push(foldingRange);
                            });
                            resolve(result);
                        }
                    });
                token.onCancellationRequested(e => this.client.abortRequest(id));
            });
        });
    }
}

class SemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private client: DefaultClient;
    constructor(client: DefaultClient) {
        this.client = client;
    }

    public async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.SemanticTokens> {
        return new Promise<vscode.SemanticTokens>((resolve, reject) => {
            this.client.notifyWhenReady(() => {
                const uriString: string = document.uri.toString();
                const id: number = ++abortRequestId;
                const params: GetSemanticTokensParams = {
                    id: id,
                    uri: uriString
                };
                this.client.languageClient.sendRequest(GetSemanticTokensRequest, params)
                    .then((tokensResult) => {
                        if (tokensResult.canceled) {
                            reject();
                        } else {
                            if (tokensResult.fileVersion !== this.client.openFileVersions.get(uriString)) {
                                reject();
                            } else {
                                const builder: vscode.SemanticTokensBuilder = new vscode.SemanticTokensBuilder(this.client.semanticTokensLegend);
                                tokensResult.tokens.forEach((token) => {
                                    builder.push(token.line, token.character, token.length, token.type, token.modifiers);
                                });
                                resolve(builder.build());
                            }
                        }
                    });
                token.onCancellationRequested(e => this.client.abortRequest(id));
            });
        });
    }
}

export class DefaultClient implements Client {
    private innerLanguageClient?: LanguageClient; // The "client" that launches and communicates with our language "server" process.
    private disposables: vscode.Disposable[] = [];
    private codeFoldingProviderDisposable: vscode.Disposable | undefined;
    private semanticTokensProviderDisposable: vscode.Disposable | undefined;
    private innerConfiguration?: configs.CppProperties;
    private rootPathFileWatcher?: vscode.FileSystemWatcher;
    private rootFolder?: vscode.WorkspaceFolder;
    private storagePath: string;
    private trackedDocuments = new Set<vscode.TextDocument>();
    private isSupported: boolean = true;
    private inactiveRegionsDecorations = new Map<string, DecorationRangesPair>();
    public openFileVersions = new Map<string, number>();
    private settingsTracker: SettingsTracker;
    private configurationProvider?: string;
    private documentSelector: DocumentFilter[] = [
        { scheme: 'file', language: 'cpp' },
        { scheme: 'file', language: 'c' }
    ];
    public semanticTokensLegend: vscode.SemanticTokensLegend | undefined;

    // The "model" that is displayed via the UI (status bar).
    private model: ClientModel = new ClientModel();

    public get TagParsingChanged(): vscode.Event<boolean> { return this.model.isTagParsing.ValueChanged; }
    public get IntelliSenseParsingChanged(): vscode.Event<boolean> { return this.model.isUpdatingIntelliSense.ValueChanged; }
    public get ReferencesCommandModeChanged(): vscode.Event<refs.ReferencesCommandMode> { return this.model.referencesCommandMode.ValueChanged; }
    public get TagParserStatusChanged(): vscode.Event<string> { return this.model.tagParserStatus.ValueChanged; }
    public get ActiveConfigChanged(): vscode.Event<string> { return this.model.activeConfigName.ValueChanged; }

    /**
     * don't use this.rootFolder directly since it can be undefined
     */
    public get RootPath(): string {
        return (this.rootFolder) ? this.rootFolder.uri.fsPath : "";
    }
    public get RootUri(): vscode.Uri | undefined {
        return (this.rootFolder) ? this.rootFolder.uri : undefined;
    }
    public get RootFolder(): vscode.WorkspaceFolder | undefined {
        return this.rootFolder;
    }
    public get Name(): string {
        return this.getName(this.rootFolder);
    }
    public get TrackedDocuments(): Set<vscode.TextDocument> {
        return this.trackedDocuments;
    }
    public get IsTagParsing(): boolean {
        return this.model.isTagParsing.Value;
    }
    public get ReferencesCommandMode(): refs.ReferencesCommandMode {
        return this.model.referencesCommandMode.Value;
    }

    public get languageClient(): LanguageClient {
        if (!this.innerLanguageClient) {
            throw new Error("Attempting to use languageClient before initialized");
        }
        return this.innerLanguageClient;
    }

    private get configuration(): configs.CppProperties {
        if (!this.innerConfiguration) {
            throw new Error("Attempting to use configuration before initialized");
        }
        return this.innerConfiguration;
    }

    private get AdditionalEnvironment(): { [key: string]: string | string[] } {
        return { workspaceFolderBasename: this.Name, workspaceStorage: this.storagePath };
    }

    private getName(workspaceFolder?: vscode.WorkspaceFolder): string {
        return workspaceFolder ? workspaceFolder.name : "untitled";
    }

    /**
     * All public methods on this class must be guarded by the "pendingTask" promise. Requests and notifications received before the task is
     * complete are executed after this promise is resolved.
     * @see requestWhenReady<T>(request)
     * @see notifyWhenReady(notify)
     */

    constructor(allClients: ClientCollection, workspaceFolder?: vscode.WorkspaceFolder) {
        this.rootFolder = workspaceFolder;
        let storagePath: string | undefined;
        if (util.extensionContext) {
            const path: string | undefined = util.extensionContext.storagePath;
            if (path) {
                storagePath = path;
            }
        }

        if (!storagePath) {
            storagePath = this.RootPath ? path.join(this.RootPath, "/.vscode") : "";
        }
        if (workspaceFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
            storagePath = path.join(storagePath, util.getUniqueWorkspaceStorageName(workspaceFolder));
        }
        this.storagePath = storagePath;
        const rootUri: vscode.Uri | undefined = this.RootUri;
        this.settingsTracker = getTracker(rootUri);
        try {
            let firstClient: boolean = false;
            if (!languageClient || languageClientCrashedNeedsRestart) {
                if (languageClientCrashedNeedsRestart) {
                    languageClientCrashedNeedsRestart = false;
                }
                languageClient = this.createLanguageClient(allClients);
                clientCollection = allClients;
                languageClient.registerProposedFeatures();
                languageClient.start();  // This returns Disposable, but doesn't need to be tracked because we call .stop() explicitly in our dispose()
                util.setProgress(util.getProgressExecutableStarted());
                firstClient = true;
            }
            ui = getUI();
            ui.bind(this);

            // requests/notifications are deferred until this.languageClient is set.
            this.queueBlockingTask(() => languageClient.onReady().then(
                () => {
                    const workspaceFolder: vscode.WorkspaceFolder | undefined = this.rootFolder;
                    this.innerConfiguration = new configs.CppProperties(rootUri, workspaceFolder);
                    this.innerConfiguration.ConfigurationsChanged((e) => this.onConfigurationsChanged(e));
                    this.innerConfiguration.SelectionChanged((e) => this.onSelectedConfigurationChanged(e));
                    this.innerConfiguration.CompileCommandsChanged((e) => this.onCompileCommandsChanged(e));
                    this.disposables.push(this.innerConfiguration);

                    this.innerLanguageClient = languageClient;
                    telemetry.logLanguageServerEvent("NonDefaultInitialCppSettings", this.settingsTracker.getUserModifiedSettings());
                    failureMessageShown = false;

                    class CodeActionProvider implements vscode.CodeActionProvider {
                        private client: DefaultClient;
                        constructor(client: DefaultClient) {
                            this.client = client;
                        }

                        public async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<(vscode.Command | vscode.CodeAction)[]> {
                            return this.client.requestWhenReady(() => {
                                let r: Range;
                                if (range instanceof vscode.Selection) {
                                    if (range.active.isBefore(range.anchor)) {
                                        r = Range.create(Position.create(range.active.line, range.active.character), Position.create(range.anchor.line, range.anchor.character));
                                    } else {
                                        r = Range.create(Position.create(range.anchor.line, range.anchor.character), Position.create(range.active.line, range.active.character));
                                    }
                                } else {
                                    r = Range.create(Position.create(range.start.line, range.start.character), Position.create(range.end.line, range.end.character));
                                }

                                const params: GetCodeActionsRequestParams = {
                                    range: r,
                                    uri: document.uri.toString()
                                };

                                return this.client.languageClient.sendRequest(GetCodeActionsRequest, params)
                                    .then((commands) => {
                                        const resultCodeActions: vscode.CodeAction[] = [];

                                        // Convert to vscode.CodeAction array
                                        commands.forEach((command) => {
                                            const title: string = util.getLocalizedString(command.localizeStringParams);
                                            const vscodeCodeAction: vscode.CodeAction = {
                                                title: title,
                                                command: {
                                                    title: title,
                                                    command: command.command,
                                                    arguments: command.arguments
                                                }
                                            };
                                            resultCodeActions.push(vscodeCodeAction);
                                        });

                                        return resultCodeActions;
                                    });
                            });
                        }
                    }

                    class DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
                        private client: DefaultClient;
                        constructor(client: DefaultClient) {
                            this.client = client;
                        }
                        private getChildrenSymbols(symbols: LocalizeDocumentSymbol[]): vscode.DocumentSymbol[] {
                            const documentSymbols: vscode.DocumentSymbol[] = [];
                            if (symbols) {
                                symbols.forEach((symbol) => {
                                    const detail: string = util.getLocalizedString(symbol.detail);
                                    const r: vscode.Range= new vscode.Range(symbol.range.start.line, symbol.range.start.character, symbol.range.end.line, symbol.range.end.character);
                                    const sr: vscode.Range= new vscode.Range(symbol.selectionRange.start.line, symbol.selectionRange.start.character, symbol.selectionRange.end.line, symbol.selectionRange.end.character);
                                    const vscodeSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol (symbol.name, detail, symbol.kind, r, sr);
                                    vscodeSymbol.children = this.getChildrenSymbols(symbol.children);
                                    documentSymbols.push(vscodeSymbol);
                                });
                            }
                            return documentSymbols;
                        }
                        public async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.SymbolInformation[] | vscode.DocumentSymbol[]> {
                            return this.client.requestWhenReady(() => {
                                const params: GetDocumentSymbolRequestParams = {
                                    uri: document.uri.toString()
                                };
                                return this.client.languageClient.sendRequest(GetDocumentSymbolRequest, params)
                                    .then((symbols) => {
                                        const resultSymbols: vscode.DocumentSymbol[] = this.getChildrenSymbols(symbols);
                                        return resultSymbols;
                                    });
                            });
                        }
                    }

                    class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
                        private client: DefaultClient;
                        constructor(client: DefaultClient) {
                            this.client = client;
                        }

                        public async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
                            const params: WorkspaceSymbolParams = {
                                query: query,
                                workspaceFolderUri: this.client.RootPath
                            };

                            return this.client.languageClient.sendRequest(GetSymbolInfoRequest, params)
                                .then((symbols) => {
                                    const resultSymbols: vscode.SymbolInformation[] = [];

                                    // Convert to vscode.Command array
                                    symbols.forEach((symbol) => {
                                        const suffix: string = util.getLocalizedString(symbol.suffix);
                                        let name: string = symbol.name;
                                        const range: vscode.Range = new vscode.Range(symbol.location.range.start.line, symbol.location.range.start.character, symbol.location.range.end.line, symbol.location.range.end.character);
                                        const uri: vscode.Uri = vscode.Uri.parse(symbol.location.uri.toString());
                                        if (suffix.length) {
                                            name = name + ' (' + suffix + ')';
                                        }
                                        const vscodeSymbol: vscode.SymbolInformation = new vscode.SymbolInformation(
                                            name,
                                            symbol.kind,
                                            range,
                                            uri,
                                            symbol.containerName
                                        );
                                        resultSymbols.push(vscodeSymbol);
                                    });
                                    return resultSymbols;
                                });
                        }
                    }

                    class FindAllReferencesProvider implements vscode.ReferenceProvider {
                        private client: DefaultClient;
                        constructor(client: DefaultClient) {
                            this.client = client;
                        }
                        public async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[] | undefined> {
                            return new Promise<vscode.Location[]>((resolve, reject) => {
                                const callback: () => void = () => {
                                    const params: FindAllReferencesParams = {
                                        position: Position.create(position.line, position.character),
                                        textDocument: this.client.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document)
                                    };
                                    referencesParams = params;
                                    this.client.notifyWhenReady(() => {
                                        // The current request is represented by referencesParams.  If a request detects
                                        // referencesParams does not match the object used when creating the request, abort it.
                                        if (params !== referencesParams) {
                                            // Complete with nothing instead of rejecting, to avoid an error message from VS Code
                                            const locations: vscode.Location[] = [];
                                            resolve(locations);
                                            return;
                                        }
                                        referencesRequestPending = true;
                                        // Register a single-fire handler for the reply.
                                        const resultCallback: refs.ReferencesResultCallback = (result: refs.ReferencesResult | null, doResolve: boolean) => {
                                            referencesRequestPending = false;
                                            const locations: vscode.Location[] = [];
                                            if (result) {
                                                result.referenceInfos.forEach((referenceInfo: refs.ReferenceInfo) => {
                                                    if (referenceInfo.type === refs.ReferenceType.Confirmed) {
                                                        const uri: vscode.Uri = vscode.Uri.file(referenceInfo.file);
                                                        const range: vscode.Range = new vscode.Range(referenceInfo.position.line, referenceInfo.position.character, referenceInfo.position.line, referenceInfo.position.character + result.text.length);
                                                        locations.push(new vscode.Location(uri, range));
                                                    }
                                                });
                                            }
                                            // If references were canceled while in a preview state, there is not an outstanding promise.
                                            if (doResolve) {
                                                resolve(locations);
                                            }
                                            if (referencesPendingCancellations.length > 0) {
                                                while (referencesPendingCancellations.length > 1) {
                                                    const pendingCancel: ReferencesCancellationState = referencesPendingCancellations[0];
                                                    referencesPendingCancellations.pop();
                                                    pendingCancel.reject();
                                                }
                                                const pendingCancel: ReferencesCancellationState = referencesPendingCancellations[0];
                                                referencesPendingCancellations.pop();
                                                pendingCancel.callback();
                                            }
                                        };
                                        if (!workspaceReferences.referencesRefreshPending) {
                                            workspaceReferences.setResultsCallback(resultCallback);
                                            workspaceReferences.startFindAllReferences(params);
                                        } else {
                                            // We are responding to a refresh (preview or final result)
                                            workspaceReferences.referencesRefreshPending = false;
                                            if (workspaceReferences.lastResults) {
                                                // This is a final result
                                                const lastResults: refs.ReferencesResult = workspaceReferences.lastResults;
                                                workspaceReferences.lastResults = null;
                                                resultCallback(lastResults, true);
                                            } else {
                                                // This is a preview (2nd or later preview)
                                                workspaceReferences.referencesRequestPending = true;
                                                workspaceReferences.setResultsCallback(resultCallback);
                                                this.client.languageClient.sendNotification(RequestReferencesNotification, false);
                                            }
                                        }
                                    });
                                    token.onCancellationRequested(e => {
                                        if (params === referencesParams) {
                                            this.client.cancelReferences();
                                        }
                                    });
                                };

                                if (referencesRequestPending || (workspaceReferences.symbolSearchInProgress && !workspaceReferences.referencesRefreshPending)) {
                                    const cancelling: boolean = referencesPendingCancellations.length > 0;
                                    referencesPendingCancellations.push({ reject: () => {
                                        // Complete with nothing instead of rejecting, to avoid an error message from VS Code
                                        const locations: vscode.Location[] = [];
                                        resolve(locations);
                                    }, callback });
                                    if (!cancelling) {
                                        renamePending = false;
                                        workspaceReferences.referencesCanceled = true;
                                        if (!referencesRequestPending) {
                                            workspaceReferences.referencesCanceledWhilePreviewing = true;
                                        }
                                        this.client.languageClient.sendNotification(CancelReferencesNotification);
                                    }
                                } else {
                                    callback();
                                }
                            });
                        }
                    }

                    class RenameProvider implements vscode.RenameProvider {
                        private client: DefaultClient;
                        constructor(client: DefaultClient) {
                            this.client = client;
                        }
                        public async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit> {
                            const settings: CppSettings = new CppSettings();
                            if (settings.renameRequiresIdentifier && !util.isValidIdentifier(newName)) {
                                vscode.window.showErrorMessage(localize("invalid.identifier.for.rename", "Invalid identifier provided for the Rename Symbol operation."));
                                const workspaceEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
                                return Promise.resolve(workspaceEdit);
                            }
                            // Normally, VS Code considers rename to be an atomic operation.
                            // If the user clicks anywhere in the document, it attempts to cancel it.
                            // Because that prevents our rename UI, we ignore cancellation requests.
                            // VS Code will attempt to issue new rename requests while another is still active.
                            // When we receive another rename request, cancel the one that is in progress.
                            renamePending = true;
                            ++renameRequestsPending;
                            return new Promise<vscode.WorkspaceEdit>((resolve, reject) => {
                                const callback: () => void = () => {
                                    const params: RenameParams = {
                                        newName: newName,
                                        position: Position.create(position.line, position.character),
                                        textDocument: this.client.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document)
                                    };
                                    referencesParams = params;
                                    this.client.notifyWhenReady(() => {
                                        // The current request is represented by referencesParams.  If a request detects
                                        // referencesParams does not match the object used when creating the request, abort it.
                                        if (params !== referencesParams) {
                                            if (--renameRequestsPending === 0) {
                                                renamePending = false;
                                            }

                                            // Complete with nothing instead of rejecting, to avoid an error message from VS Code
                                            const workspaceEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
                                            resolve(workspaceEdit);
                                            return;
                                        }
                                        referencesRequestPending = true;
                                        workspaceReferences.setResultsCallback((referencesResult: refs.ReferencesResult | null, doResolve: boolean) => {
                                            referencesRequestPending = false;
                                            --renameRequestsPending;
                                            const workspaceEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
                                            const cancelling: boolean = referencesPendingCancellations.length > 0;
                                            if (cancelling) {
                                                while (referencesPendingCancellations.length > 1) {
                                                    const pendingCancel: ReferencesCancellationState = referencesPendingCancellations[0];
                                                    referencesPendingCancellations.pop();
                                                    pendingCancel.reject();
                                                }
                                                const pendingCancel: ReferencesCancellationState = referencesPendingCancellations[0];
                                                referencesPendingCancellations.pop();
                                                pendingCancel.callback();
                                            } else {
                                                if (renameRequestsPending === 0) {
                                                    renamePending = false;
                                                }
                                                // If rename UI was canceled, we will get a null result.
                                                // If null, return an empty list to avoid Rename failure dialog.
                                                if (referencesResult) {
                                                    for (const reference of referencesResult.referenceInfos) {
                                                        const uri: vscode.Uri = vscode.Uri.file(reference.file);
                                                        const range: vscode.Range = new vscode.Range(reference.position.line, reference.position.character, reference.position.line, reference.position.character + referencesResult.text.length);
                                                        const metadata: vscode.WorkspaceEditEntryMetadata = {
                                                            needsConfirmation: reference.type !== refs.ReferenceType.Confirmed,
                                                            label: refs.getReferenceTagString(reference.type, false, true),
                                                            iconPath: refs.getReferenceItemIconPath(reference.type, false)
                                                        };
                                                        workspaceEdit.replace(uri, range, newName, metadata);
                                                    }
                                                }
                                            }
                                            if (referencesResult && (referencesResult.referenceInfos === null || referencesResult.referenceInfos.length === 0)) {
                                                vscode.window.showErrorMessage(localize("unable.to.locate.selected.symbol", "A definition for the selected symbol could not be located."));
                                            }
                                            resolve(workspaceEdit);
                                        });
                                        workspaceReferences.startRename(params);
                                    });
                                };

                                if (referencesRequestPending || workspaceReferences.symbolSearchInProgress) {
                                    const cancelling: boolean = referencesPendingCancellations.length > 0;
                                    referencesPendingCancellations.push({ reject: () => {
                                        --renameRequestsPending;
                                        // Complete with nothing instead of rejecting, to avoid an error message from VS Code
                                        const workspaceEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
                                        resolve(workspaceEdit);
                                    }, callback });
                                    if (!cancelling) {
                                        workspaceReferences.referencesCanceled = true;
                                        if (!referencesRequestPending) {
                                            workspaceReferences.referencesCanceledWhilePreviewing = true;
                                        }
                                        this.client.languageClient.sendNotification(CancelReferencesNotification);
                                    }
                                } else {
                                    callback();
                                }
                            });
                        }
                    }

                    // Semantic token types are identified by indexes in this list of types, in the legend.
                    const tokenTypesLegend: string[] = [];
                    for (const e in SemanticTokenTypes) {
                        // An enum is actually a set of mappings from key <=> value.  Enumerate over only the names.
                        // This allow us to represent the constants using an enum, which we can match in native code.
                        if (isNaN(Number(e))) {
                            tokenTypesLegend.push(e);
                        }
                    }
                    // Semantic token modifiers are bit indexes corresponding to the indexes in this list of modifiers in the legend.
                    const tokenModifiersLegend: string[] = [];
                    for (const e in SemanticTokenModifiers) {
                        if (isNaN(Number(e))) {
                            tokenModifiersLegend.push(e);
                        }
                    }
                    this.semanticTokensLegend = new vscode.SemanticTokensLegend(tokenTypesLegend, tokenModifiersLegend);

                    if (firstClient) {
                        workspaceReferences = new refs.ReferencesManager(this);

                        // The configurations will not be sent to the language server until the default include paths and frameworks have been set.
                        // The event handlers must be set before this happens.
                        return languageClient.sendRequest(QueryCompilerDefaultsRequest, {}).then((inputCompilerDefaults: configs.CompilerDefaults) => {
                            compilerDefaults = inputCompilerDefaults;
                            this.configuration.CompilerDefaults = compilerDefaults;

                            // Only register file watchers, providers, and the real commands after the extension has finished initializing,
                            // e.g. prevents empty c_cpp_properties.json from generation.
                            registerCommands();

                            this.registerFileWatcher();

                            this.disposables.push(vscode.languages.registerRenameProvider(this.documentSelector, new RenameProvider(this)));
                            this.disposables.push(vscode.languages.registerReferenceProvider(this.documentSelector, new FindAllReferencesProvider(this)));
                            this.disposables.push(vscode.languages.registerWorkspaceSymbolProvider(new WorkspaceSymbolProvider(this)));
                            this.disposables.push(vscode.languages.registerDocumentSymbolProvider(this.documentSelector, new DocumentSymbolProvider(this), undefined));
                            this.disposables.push(vscode.languages.registerCodeActionsProvider(this.documentSelector, new CodeActionProvider(this), undefined));
                            const settings: CppSettings = new CppSettings();
                            if (settings.codeFolding) {
                                this.codeFoldingProviderDisposable = vscode.languages.registerFoldingRangeProvider(this.documentSelector, new FoldingRangeProvider(this));
                            }
                            if (settings.enhancedColorization && this.semanticTokensLegend) {
                                this.semanticTokensProviderDisposable = vscode.languages.registerDocumentSemanticTokensProvider(this.documentSelector, new SemanticTokensProvider(this), this.semanticTokensLegend);
                            }

                            // Listen for messages from the language server.
                            this.registerNotifications();
                        });
                    } else {
                        this.configuration.CompilerDefaults = compilerDefaults;
                    }
                },
                (err) => {
                    this.isSupported = false;   // Running on an OS we don't support yet.
                    if (!failureMessageShown) {
                        failureMessageShown = true;
                        vscode.window.showErrorMessage(localize("unable.to.start", "Unable to start the C/C++ language server. IntelliSense features will be disabled. Error: {0}", String(err)));
                    }
                }));
        } catch (err) {
            this.isSupported = false;   // Running on an OS we don't support yet.
            if (!failureMessageShown) {
                failureMessageShown = true;
                let additionalInfo: string;
                if (err.code === "EPERM") {
                    additionalInfo = localize('check.permissions', "EPERM: Check permissions for '{0}'", getLanguageServerFileName());
                } else {
                    additionalInfo = String(err);
                }
                vscode.window.showErrorMessage(localize("unable.to.start", "Unable to start the C/C++ language server. IntelliSense features will be disabled. Error: {0}", additionalInfo));
            }
        }
    }

    public sendFindAllReferencesNotification(params: FindAllReferencesParams): void {
        this.languageClient.sendNotification(FindAllReferencesNotification, params);
    }

    public sendRenameNofication(params: RenameParams): void {
        this.languageClient.sendNotification(RenameNotification, params);
    }

    private createLanguageClient(allClients: ClientCollection): LanguageClient {
        const serverModule: string = getLanguageServerFileName();
        const exeExists: boolean = fs.existsSync(serverModule);
        if (!exeExists) {
            telemetry.logLanguageServerEvent("missingLanguageServerBinary");
            throw String('Missing binary at ' + serverModule);
        }
        const serverName: string = this.getName(this.rootFolder);
        const serverOptions: ServerOptions = {
            run: { command: serverModule },
            debug: { command: serverModule, args: [ serverName ] }
        };

        // Get all the per-workspace settings.
        // They're sent as individual arrays to make it easier to process on the server,
        // so don't refactor this to an array of settings objects unless a good method is
        // found for processing data in that format on the server.
        const settings_clangFormatPath: (string | undefined)[] = [];
        const settings_clangFormatStyle: (string | undefined)[] = [];
        const settings_clangFormatFallbackStyle: (string | undefined)[] = [];
        const settings_clangFormatSortIncludes: (string | undefined)[] = [];
        const settings_filesExclude: (vscode.WorkspaceConfiguration | undefined)[] = [];
        const settings_searchExclude: (vscode.WorkspaceConfiguration | undefined)[] = [];
        const settings_editorTabSize: (number | undefined)[] = [];
        const settings_intelliSenseEngine: (string | undefined)[] = [];
        const settings_intelliSenseEngineFallback: (string | undefined)[] = [];
        const settings_errorSquiggles: (string | undefined)[] = [];
        const settings_dimInactiveRegions: boolean[] = [];
        const settings_enhancedColorization: string[] = [];
        const settings_suggestSnippets: (boolean | undefined)[] = [];
        const settings_exclusionPolicy: (string | undefined)[] = [];
        const settings_preferredPathSeparator: (string | undefined)[] = [];
        const settings_defaultSystemIncludePath: (string[] | undefined)[] = [];
        const settings_intelliSenseCachePath: (string | undefined)[] = [];
        const settings_intelliSenseCacheSize: (number | undefined)[] = [];
        const settings_autoComplete: (string | undefined)[] = [];
        const settings_formatting: (string | undefined)[] = [];
        const workspaceSettings: CppSettings = new CppSettings();
        const workspaceOtherSettings: OtherSettings = new OtherSettings();
        {
            const settings: CppSettings[] = [];
            const otherSettings: OtherSettings[] = [];

            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                    settings.push(new CppSettings(workspaceFolder.uri));
                    otherSettings.push(new OtherSettings(workspaceFolder.uri));
                }
            } else {
                settings.push(workspaceSettings);
                otherSettings.push(workspaceOtherSettings);
            }

            for (const setting of settings) {
                settings_clangFormatPath.push(util.resolveVariables(setting.clangFormatPath, this.AdditionalEnvironment));
                settings_clangFormatStyle.push(setting.clangFormatStyle);
                settings_clangFormatFallbackStyle.push(setting.clangFormatFallbackStyle);
                settings_clangFormatSortIncludes.push(setting.clangFormatSortIncludes);
                settings_intelliSenseEngine.push(setting.intelliSenseEngine);
                settings_intelliSenseEngineFallback.push(setting.intelliSenseEngineFallback);
                settings_errorSquiggles.push(setting.errorSquiggles);
                settings_dimInactiveRegions.push(setting.dimInactiveRegions);
                settings_enhancedColorization.push(setting.enhancedColorization ? "Enabled" : "Disabled");
                settings_suggestSnippets.push(setting.suggestSnippets);
                settings_exclusionPolicy.push(setting.exclusionPolicy);
                settings_preferredPathSeparator.push(setting.preferredPathSeparator);
                settings_defaultSystemIncludePath.push(setting.defaultSystemIncludePath);
                settings_intelliSenseCachePath.push(util.resolveCachePath(setting.intelliSenseCachePath, this.AdditionalEnvironment));
                settings_intelliSenseCacheSize.push(setting.intelliSenseCacheSize);
                settings_autoComplete.push(setting.autoComplete);
                settings_formatting.push(setting.formatting);
            }

            for (const otherSetting of otherSettings) {
                settings_filesExclude.push(otherSetting.filesExclude);
                settings_searchExclude.push(otherSetting.searchExclude);
                settings_editorTabSize.push(otherSetting.editorTabSize);
            }
        }

        const abTestSettings: ABTestSettings = getABTestSettings();

        let intelliSenseCacheDisabled: boolean = false;
        if (os.platform() === "darwin") {
            const releaseParts: string[] = os.release().split(".");
            if (releaseParts.length >= 1) {
                // AutoPCH doesn't work for older Mac OS's.
                intelliSenseCacheDisabled = parseInt(releaseParts[0]) < 17;
            }
        }

        const localizedStrings: string[] = [];
        for (let i: number = 0; i < localizedStringCount; i++) {
            localizedStrings.push(lookupString(i));
        }

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'cpp' },
                { scheme: 'file', language: 'c' }
            ],
            initializationOptions: {
                clang_format_path: settings_clangFormatPath,
                clang_format_style: settings_clangFormatStyle,
                clang_format_fallbackStyle: settings_clangFormatFallbackStyle,
                clang_format_sortIncludes: settings_clangFormatSortIncludes,
                formatting: settings_formatting,
                extension_path: util.extensionPath,
                exclude_files: settings_filesExclude,
                exclude_search: settings_searchExclude,
                associations: workspaceOtherSettings.filesAssociations,
                storage_path: this.storagePath,
                tabSize: settings_editorTabSize,
                intelliSenseEngine: settings_intelliSenseEngine,
                intelliSenseEngineFallback: settings_intelliSenseEngineFallback,
                intelliSenseCacheDisabled: intelliSenseCacheDisabled,
                intelliSenseCachePath : settings_intelliSenseCachePath,
                intelliSenseCacheSize : settings_intelliSenseCacheSize,
                autocomplete: settings_autoComplete,
                errorSquiggles: settings_errorSquiggles,
                dimInactiveRegions: settings_dimInactiveRegions,
                enhancedColorization: settings_enhancedColorization,
                suggestSnippets: settings_suggestSnippets,
                loggingLevel: workspaceSettings.loggingLevel,
                workspaceParsingPriority: workspaceSettings.workspaceParsingPriority,
                workspaceSymbols: workspaceSettings.workspaceSymbols,
                exclusionPolicy: settings_exclusionPolicy,
                preferredPathSeparator: settings_preferredPathSeparator,
                default: {
                    systemIncludePath: settings_defaultSystemIncludePath
                },
                vcpkg_root: util.getVcpkgRoot(),
                gotoDefIntelliSense: abTestSettings.UseGoToDefIntelliSense,
                experimentalFeatures: workspaceSettings.experimentalFeatures,
                edgeMessagesDirectory: path.join(util.getExtensionFilePath("bin"), "messages", util.getLocaleId()),
                localizedStrings: localizedStrings
            },
            middleware: createProtocolFilter(allClients),
            errorHandler: {
                error: () => ErrorAction.Continue,
                closed: () => {
                    languageClientCrashTimes.push(Date.now());
                    languageClientCrashedNeedsRestart = true;
                    telemetry.logLanguageServerEvent("languageClientCrash");
                    if (languageClientCrashTimes.length < 5) {
                        allClients.forEach(client => { allClients.replace(client, true); });
                    } else {
                        const elapsed: number = languageClientCrashTimes[languageClientCrashTimes.length - 1] - languageClientCrashTimes[0];
                        if (elapsed <= 3 * 60 * 1000) {
                            vscode.window.showErrorMessage(localize('server.crashed2', "The language server crashed 5 times in the last 3 minutes. It will not be restarted."));
                            allClients.forEach(client => { allClients.replace(client, false); });
                        } else {
                            languageClientCrashTimes.shift();
                            allClients.forEach(client => { allClients.replace(client, true); });
                        }
                    }
                    return CloseAction.DoNotRestart;
                }
            }

            // TODO: should I set the output channel?  Does this sort output between servers?
        };

        // Create the language client
        return new LanguageClient(`cpptools`, serverOptions, clientOptions);
    }

    public sendAllSettings(): void {
        const cppSettingsScoped: { [key: string]: any } = {};
        // Gather the C_Cpp settings
        {
            const cppSettingsResourceScoped: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("C_Cpp", this.RootUri);
            const cppSettingsNonScoped: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("C_Cpp");

            for (const key in cppSettingsResourceScoped) {
                const curSetting: any = util.packageJson.contributes.configuration.properties["C_Cpp." + key];
                if (curSetting === undefined) {
                    continue;
                }
                const settings: vscode.WorkspaceConfiguration = (curSetting.scope === "resource" || curSetting.scope === "machine-overridable") ? cppSettingsResourceScoped : cppSettingsNonScoped;
                cppSettingsScoped[key] = settings.get(key);
            }
            cppSettingsScoped["default"] = { systemIncludePath: cppSettingsResourceScoped.get("default.systemIncludePath") };
        }

        // Unlike the LSP message, the event does not contain all settings as a payload, so we need to
        // build a new JSON object with everything we need on the native side.
        const settings: any = {
            C_Cpp: {
                ...cppSettingsScoped,
                tabSize: vscode.workspace.getConfiguration("editor.tabSize", this.RootUri)
            },
            files: {
                exclude: vscode.workspace.getConfiguration("files.exclude", this.RootUri),
                associations: new OtherSettings().filesAssociations
            },
            search: {
                exclude: vscode.workspace.getConfiguration("search.exclude", this.RootUri)
            }
        };

        this.sendDidChangeSettings(settings);
    }

    public sendDidChangeSettings(settings: any): void {
        // Send settings json to native side
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(DidChangeSettingsNotification, {settings, workspaceFolderUri: this.RootPath});
        });
    }

    public onDidChangeSettings(event: vscode.ConfigurationChangeEvent, isFirstClient: boolean): { [key: string]: string } {
        this.sendAllSettings();
        const changedSettings: { [key: string]: string } = this.settingsTracker.getChangedSettings();
        this.notifyWhenReady(() => {
            if (Object.keys(changedSettings).length > 0) {
                if (changedSettings["commentContinuationPatterns"]) {
                    updateLanguageConfigurations();
                }
                if (changedSettings["codeFolding"]) {
                    const settings: CppSettings = new CppSettings();
                    if (settings.codeFolding) {
                        this.codeFoldingProviderDisposable = vscode.languages.registerFoldingRangeProvider(this.documentSelector, new FoldingRangeProvider(this));
                    } else if (this.codeFoldingProviderDisposable) {
                        this.codeFoldingProviderDisposable.dispose();
                        this.codeFoldingProviderDisposable = undefined;
                    }
                }
                if (changedSettings["enhancedColorization"]) {
                    const settings: CppSettings = new CppSettings();
                    if (settings.enhancedColorization && this.semanticTokensLegend) {
                        this.semanticTokensProviderDisposable = vscode.languages.registerDocumentSemanticTokensProvider(this.documentSelector, new SemanticTokensProvider(this), this.semanticTokensLegend);                        ;
                    } else if (this.semanticTokensProviderDisposable) {
                        this.semanticTokensProviderDisposable.dispose();
                        this.semanticTokensProviderDisposable = undefined;
                    }
                }
                this.configuration.onDidChangeSettings();
                telemetry.logLanguageServerEvent("CppSettingsChange", changedSettings, undefined);
            }
        });
        return changedSettings;
    }

    public onDidChangeVisibleTextEditors(editors: vscode.TextEditor[]): void {
        const settings: CppSettings = new CppSettings(this.RootUri);
        if (settings.dimInactiveRegions) {
            // Apply text decorations to inactive regions
            for (const e of editors) {
                const valuePair: DecorationRangesPair | undefined = this.inactiveRegionsDecorations.get(e.document.uri.toString());
                if (valuePair) {
                    e.setDecorations(valuePair.decoration, valuePair.ranges); // VSCode clears the decorations when the text editor becomes invisible
                }
            }
        }
    }

    public onDidChangeTextDocument(textDocumentChangeEvent: vscode.TextDocumentChangeEvent): void {
        if (textDocumentChangeEvent.document.uri.scheme === "file") {
            if (textDocumentChangeEvent.document.languageId === "cpp" || textDocumentChangeEvent.document.languageId === "c") {
                // If any file has changed, we need to abort the current rename operation
                if (renamePending) {
                    this.cancelReferences();
                }

                const oldVersion: number | undefined = this.openFileVersions.get(textDocumentChangeEvent.document.uri.toString());
                const newVersion: number = textDocumentChangeEvent.document.version;
                if (oldVersion === undefined || newVersion > oldVersion) {
                    this.openFileVersions.set(textDocumentChangeEvent.document.uri.toString(), newVersion);
                }
            }
        }
    }

    public onDidOpenTextDocument(document: vscode.TextDocument): void {
        if (document.uri.scheme === "file") {
            this.openFileVersions.set(document.uri.toString(), document.version);
        }
    }

    public onDidCloseTextDocument(document: vscode.TextDocument): void {
        this.openFileVersions.delete(document.uri.toString());
    }

    private registeredProviders: CustomConfigurationProvider1[] = [];
    public onRegisterCustomConfigurationProvider(provider: CustomConfigurationProvider1): Thenable<void> {
        const onRegistered: () => void = () => {
            // version 2 providers control the browse.path. Avoid thrashing the tag parser database by pausing parsing until
            // the provider has sent the correct browse.path value.
            if (provider.version >= Version.v2) {
                this.pauseParsing();
            }
        };
        return this.notifyWhenReady(() => {
            if (this.registeredProviders.includes(provider)) {
                return; // Prevent duplicate processing.
            }
            this.registeredProviders.push(provider);
            const rootFolder: vscode.WorkspaceFolder | undefined = this.RootFolder;
            if (!rootFolder) {
                return; // There is no c_cpp_properties.json to edit because there is no folder open.
            }
            const selectedProvider: string | undefined = this.configuration.CurrentConfigurationProvider;
            if (!selectedProvider) {
                const ask: PersistentFolderState<boolean> = new PersistentFolderState<boolean>("Client.registerProvider", true, rootFolder);
                // If c_cpp_properties.json and settings.json are both missing, reset our prompt
                if (!fs.existsSync(`${this.RootPath}/.vscode/c_cpp_properties.json`) && !fs.existsSync(`${this.RootPath}/.vscode/settings.json`)) {
                    ask.Value = true;
                }
                if (ask.Value) {
                    ui.showConfigureCustomProviderMessage(() => {
                        const message: string = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1)
                            ? localize("provider.configure.folder", "{0} would like to configure IntelliSense for the '{1}' folder.", provider.name, this.Name)
                            : localize("provider.configure.this.folder", "{0} would like to configure IntelliSense for this folder.", provider.name);
                        const allow: string = localize("allow.button", "Allow");
                        const dontAllow: string = localize("dont.allow.button", "Don't Allow");
                        const askLater: string = localize("ask.me.later.button", "Ask Me Later");

                        return vscode.window.showInformationMessage(message, allow, dontAllow, askLater).then(result => {
                            switch (result) {
                                case allow: {
                                    this.configuration.updateCustomConfigurationProvider(provider.extensionId).then(() => {
                                        onRegistered();
                                        ask.Value = false;
                                        telemetry.logLanguageServerEvent("customConfigurationProvider", { "providerId": provider.extensionId });
                                    });
                                    return true;
                                }
                                case dontAllow: {
                                    ask.Value = false;
                                    break;
                                }
                                default: {
                                    break;
                                }
                            }
                            return false;
                        });
                    },
                    () => ask.Value = false);
                }
            } else if (isSameProviderExtensionId(selectedProvider, provider.extensionId)) {
                onRegistered();
                telemetry.logLanguageServerEvent("customConfigurationProvider", { "providerId": provider.extensionId });
            } else if (selectedProvider === provider.name) {
                onRegistered();
                this.configuration.updateCustomConfigurationProvider(provider.extensionId); // v0 -> v1 upgrade. Update the configurationProvider in c_cpp_properties.json
            }
        });
    }

    public updateCustomConfigurations(requestingProvider?: CustomConfigurationProvider1): Thenable<void> {
        return this.notifyWhenReady(() => {
            if (!this.configurationProvider) {
                this.clearCustomConfigurations();
                return;
            }
            const currentProvider: CustomConfigurationProvider1 | undefined = getCustomConfigProviders().get(this.configurationProvider);
            if (!currentProvider) {
                this.clearCustomConfigurations();
                return;
            }
            if (requestingProvider && requestingProvider.extensionId !== currentProvider.extensionId) {
                // If we are being called by a configuration provider other than the current one, ignore it.
                return;
            }

            this.clearCustomConfigurations();
            this.trackedDocuments.forEach(document => {
                this.provideCustomConfiguration(document.uri, undefined);
            });
        });
    }

    public updateCustomBrowseConfiguration(requestingProvider?: CustomConfigurationProvider1): Thenable<void> {
        return this.notifyWhenReady(() => {
            if (!this.configurationProvider) {
                return;
            }
            console.log("updateCustomBrowseConfiguration");
            const currentProvider: CustomConfigurationProvider1 | undefined = getCustomConfigProviders().get(this.configurationProvider);
            if (!currentProvider || (requestingProvider && requestingProvider.extensionId !== currentProvider.extensionId)) {
                return;
            }

            const tokenSource: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();
            const task: () => Thenable<WorkspaceBrowseConfiguration | null> = async () => {
                if (this.RootUri && await currentProvider.canProvideBrowseConfigurationsPerFolder(tokenSource.token)) {
                    return (currentProvider.provideFolderBrowseConfiguration(this.RootUri, tokenSource.token));
                }
                if (await currentProvider.canProvideBrowseConfiguration(tokenSource.token)) {
                    return currentProvider.provideBrowseConfiguration(tokenSource.token);
                }
                if (currentProvider.version >= Version.v2) {
                    console.warn("failed to provide browse configuration");
                }
                return null;
            };

            // Initiate request for custom configuration.
            // Resume parsing on either resolve or reject, only if parsing was not resumed due to timeout
            let hasCompleted: boolean = false;
            task().then(async config => {
                if (!config) {
                    return;
                }
                if (currentProvider.version < Version.v3) {
                    // This is to get around the (fixed) CMake Tools bug: https://github.com/microsoft/vscode-cmake-tools/issues/1073
                    for (const c of config.browsePath) {
                        if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(c)) === this.RootFolder) {
                            this.sendCustomBrowseConfiguration(config, currentProvider.extensionId);
                            break;
                        }
                    }
                } else {
                    this.sendCustomBrowseConfiguration(config, currentProvider.extensionId);
                }
                if (!hasCompleted) {
                    hasCompleted = true;
                    if (currentProvider.version >= Version.v2) {
                        this.resumeParsing();
                    }
                }
            }, () => {
                if (!hasCompleted) {
                    hasCompleted = true;
                    if (currentProvider.version >= Version.v2) {
                        this.resumeParsing();
                    }
                }
            });

            // Set up a timeout to use previously received configuration and resume parsing if the provider times out
            global.setTimeout(async () => {
                if (!hasCompleted) {
                    hasCompleted = true;
                    this.sendCustomBrowseConfiguration(null, undefined, true);
                    if (currentProvider.version >= Version.v2) {
                        console.warn("Configuration Provider timed out in {0}ms.", configProviderTimeout);
                        this.resumeParsing();
                    }
                }
            }, configProviderTimeout);
        });
    }

    public toggleReferenceResultsView(): void {
        workspaceReferences.toggleGroupView();
    }

    public async logDiagnostics(): Promise<void> {
        const response: GetDiagnosticsResult = await this.requestWhenReady(() => this.languageClient.sendRequest(GetDiagnosticsRequest, null));
        if (!diagnosticsChannel) {
            diagnosticsChannel = vscode.window.createOutputChannel(localize("c.cpp.diagnostics", "C/C++ Diagnostics"));
            workspaceDisposables.push(diagnosticsChannel);
        }

        const header: string = `-------- Diagnostics - ${new Date().toLocaleString()}\n`;
        const version: string = `Version: ${util.packageJson.version}\n`;
        let configJson: string = "";
        if (this.configuration.CurrentConfiguration) {
            configJson = `Current Configuration:\n${JSON.stringify(this.configuration.CurrentConfiguration, null, 4)}\n`;
        }
        diagnosticsChannel.appendLine(`${header}${version}${configJson}${response.diagnostics}`);
        diagnosticsChannel.show(false);
    }

    public async rescanFolder(): Promise<void> {
        await this.notifyWhenReady(() => this.languageClient.sendNotification(RescanFolderNotification));
    }

    public async provideCustomConfiguration(docUri: vscode.Uri, requestFile?: string): Promise<void> {
        const onFinished: () => void = () => {
            if (requestFile) {
                this.languageClient.sendNotification(FinishedRequestCustomConfig, requestFile);
            }
        };
        const providerId: string | undefined = this.configurationProvider;
        if (!providerId) {
            onFinished();
            return Promise.resolve();
        }
        const provider: CustomConfigurationProvider1 | undefined = getCustomConfigProviders().get(providerId);
        if (!provider) {
            onFinished();
            return Promise.resolve();
        }
        if (!provider.isReady) {
            onFinished();
            return Promise.reject(`${this.configurationProvider} is not ready`);
        }
        return this.queueBlockingTask(async () => {
            const tokenSource: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();
            console.log("provideCustomConfiguration");

            const providerName: string = provider.name;

            const params: QueryTranslationUnitSourceParams = {
                uri: docUri.toString(),
                workspaceFolderUri: this.RootPath
            };
            const response: QueryTranslationUnitSourceResult = await this.languageClient.sendRequest(QueryTranslationUnitSourceRequest, params);
            if (!response.candidates || response.candidates.length === 0) {
                // If we didn't receive any candidates, no configuration is needed.
                onFinished();
                return Promise.resolve();
            }

            // Need to loop through candidates, to see if we can get a custom configuration from any of them.
            // Wrap all lookups in a single task, so we can apply a timeout to the entire duration.
            const provideConfigurationAsync: () => Thenable<SourceFileConfigurationItem[] | null | undefined> = async () => {
                if (provider) {
                    for (let i: number = 0; i < response.candidates.length; ++i) {
                        try {
                            const candidate: string = response.candidates[i];
                            const tuUri: vscode.Uri = vscode.Uri.parse(candidate);
                            if (await provider.canProvideConfiguration(tuUri, tokenSource.token)) {
                                const configs: SourceFileConfigurationItem[] = await provider.provideConfigurations([tuUri], tokenSource.token);
                                if (configs && configs.length > 0 && configs[0]) {
                                    return configs;
                                }
                            }
                            if (tokenSource.token.isCancellationRequested) {
                                return null;
                            }
                        } catch (err) {
                            console.warn("Caught exception request configuration");
                        }
                    }
                }
            };
            return this.callTaskWithTimeout(provideConfigurationAsync, configProviderTimeout, tokenSource).then(
                (configs?: SourceFileConfigurationItem[] | null) => {
                    if (configs && configs.length > 0) {
                        this.sendCustomConfigurations(configs);
                    }
                    onFinished();
                },
                (err) => {
                    if (requestFile) {
                        onFinished();
                        return;
                    }
                    const settings: CppSettings = new CppSettings(this.RootUri);
                    if (settings.configurationWarnings === "Enabled" && !this.isExternalHeader(docUri) && !vscode.debug.activeDebugSession) {
                        const dismiss: string = localize("dismiss.button", "Dismiss");
                        const disable: string = localize("diable.warnings.button", "Disable Warnings");
                        const configName: string | undefined = this.configuration.CurrentConfiguration?.name;
                        if (!configName) {
                            return;
                        }
                        let message: string = localize("unable.to.provide.configuraiton",
                            "{0} is unable to provide IntelliSense configuration information for '{1}'. Settings from the '{2}' configuration will be used instead.",
                            providerName, docUri.fsPath, configName);
                        if (err) {
                            message += ` (${err})`;
                        }

                        vscode.window.showInformationMessage(message, dismiss, disable).then(response => {
                            switch (response) {
                                case disable: {
                                    settings.toggleSetting("configurationWarnings", "Enabled", "Disabled");
                                    break;
                                }
                            }
                        });
                    }
                });
        });
    }

    private async handleRequestCustomConfig(requestFile: string): Promise<void> {
        await this.provideCustomConfiguration(vscode.Uri.file(requestFile), requestFile);
    }

    private isExternalHeader(uri: vscode.Uri): boolean {
        const rootUri: vscode.Uri | undefined = this.RootUri;
        return !rootUri || (util.isHeader(uri) && !uri.toString().startsWith(rootUri.toString()));
    }

    public getCurrentConfigName(): Thenable<string | undefined> {
        return this.queueTask(() => Promise.resolve(this.configuration.CurrentConfiguration?.name));
    }

    public getCurrentConfigCustomVariable(variableName: string): Thenable<string> {
        return this.queueTask(() => Promise.resolve(this.configuration.CurrentConfiguration?.customConfigurationVariables?.[variableName] || ''));
    }

    public setCurrentConfigName(configurationName: string): Thenable<void> {
        return this.queueTask(() => new Promise((resolve, reject) => {
            const configurations: configs.Configuration[] = this.configuration.Configurations || [];
            const configurationIndex: number = configurations.findIndex((config) => config.name === configurationName);

            if (configurationIndex !== -1) {
                this.configuration.select(configurationIndex);
                resolve();
            } else {
                reject(new Error(localize("config.not.found", "The requested configuration name is not found: {0}", configurationName)));
            }
        }));
    }

    public getCurrentCompilerPathAndArgs(): Thenable<util.CompilerPathAndArgs | undefined> {
        return this.queueTask(() => Promise.resolve(
            util.extractCompilerPathAndArgs(
                this.configuration.CurrentConfiguration?.compilerPath,
                this.configuration.CurrentConfiguration?.compilerArgs)
        ));
    }

    public getVcpkgInstalled(): Thenable<boolean> {
        return this.queueTask(() => Promise.resolve(this.configuration.VcpkgInstalled));
    }

    public getVcpkgEnabled(): Thenable<boolean> {
        const cppSettings: CppSettings = new CppSettings(this.RootUri);
        return Promise.resolve(cppSettings.vcpkgEnabled === true);
    }

    public getKnownCompilers(): Thenable<configs.KnownCompiler[] | undefined> {
        return this.queueTask(() => Promise.resolve(this.configuration.KnownCompiler));
    }

    /**
     * Take ownership of a document that was previously serviced by another client.
     * This process involves sending a textDocument/didOpen message to the server so
     * that it knows about the file, as well as adding it to this client's set of
     * tracked documents.
     */
    public takeOwnership(document: vscode.TextDocument): void {
        const params: DidOpenTextDocumentParams = {
            textDocument: {
                uri: document.uri.toString(),
                languageId: document.languageId,
                version: document.version,
                text: document.getText()
            }
        };
        this.notifyWhenReady(() => this.languageClient.sendNotification(DidOpenNotification, params));
        this.trackedDocuments.add(document);
    }

    /**
     * wait until the all pendingTasks are complete (e.g. language client is ready for use)
     * before attempting to send messages or operate on the client.
     */

    public queueTask<T>(task: () => Thenable<T>): Thenable<T> {
        if (this.isSupported) {
            const nextTask: () => Thenable<T> = async () => {
                try {
                    return await task();
                } catch (err) {
                    console.error(err);
                    throw err;
                }
            };

            if (pendingTask && !pendingTask.Done) {
                // We don't want the queue to stall because of a rejected promise.
                return pendingTask.getPromise().then(nextTask, nextTask);
            } else {
                pendingTask = undefined;
                return nextTask();
            }
        } else {
            return Promise.reject(localize("unsupported.client", "Unsupported client"));
        }
    }

    /**
     * Queue a task that blocks all future tasks until it completes. This is currently only intended to be used
     * during language client startup and for custom configuration providers.
     * @param task The task that blocks all future tasks
     */
    private queueBlockingTask<T>(task: () => Thenable<T>): Thenable<T> {
        if (this.isSupported) {
            pendingTask = new util.BlockingTask<T>(task, pendingTask);
            return pendingTask.getPromise();
        } else {
            return Promise.reject(localize("unsupported.client", "Unsupported client"));
        }
    }

    private callTaskWithTimeout<T>(task: () => Thenable<T>, ms: number, cancelToken?: vscode.CancellationTokenSource): Thenable<T> {
        let timer: NodeJS.Timer;
        // Create a promise that rejects in <ms> milliseconds
        const timeout: () => Promise<T> = () => new Promise<T>((resolve, reject) => {
            timer = global.setTimeout(() => {
                clearTimeout(timer);
                if (cancelToken) {
                    cancelToken.cancel();
                }
                reject(localize("timed.out", "Timed out in {0}ms.", ms));
            }, ms);
        });

        // Returns a race between our timeout and the passed in promise
        return Promise.race([task(), timeout()]).then(
            (result: any) => {
                clearTimeout(timer);
                return result;
            },
            (error: any) => {
                clearTimeout(timer);
                throw error;
            });
    }

    public requestWhenReady<T>(request: () => Thenable<T>): Thenable<T> {
        return this.queueTask(request);
    }

    public notifyWhenReady<T>(notify: () => T): Thenable<T> {
        const task: () => Thenable<T> = () => new Promise<T>(resolve => {
            resolve(notify());
        });
        return this.queueTask(task);
    }

    /**
     * listen for notifications from the language server.
     */
    private registerNotifications(): void {
        console.assert(this.languageClient !== undefined, "This method must not be called until this.languageClient is set in \"onReady\"");

        this.languageClient.onNotification(ReloadWindowNotification, () => util.promptForReloadWindowDueToSettingsChange());
        this.languageClient.onNotification(LogTelemetryNotification, logTelemetry);
        this.languageClient.onNotification(ReportStatusNotification, (e) => this.updateStatus(e));
        this.languageClient.onNotification(ReportTagParseStatusNotification, (e) => this.updateTagParseStatus(e));
        this.languageClient.onNotification(InactiveRegionNotification, (e) => this.updateInactiveRegions(e));
        this.languageClient.onNotification(CompileCommandsPathsNotification, (e) => this.promptCompileCommands(e));
        this.languageClient.onNotification(ReferencesNotification, (e) => this.processReferencesResult(e.referencesResult));
        this.languageClient.onNotification(ReportReferencesProgressNotification, (e) => this.handleReferencesProgress(e));
        this.languageClient.onNotification(RequestCustomConfig, (requestFile: string) => {
            const client: DefaultClient = <DefaultClient>clientCollection.getClientFor(vscode.Uri.file(requestFile));
            client.handleRequestCustomConfig(requestFile);
        });
        this.languageClient.onNotification(PublishDiagnosticsNotification, publishDiagnostics);
        this.languageClient.onNotification(ShowMessageWindowNotification, showMessageWindow);
        this.languageClient.onNotification(ReportTextDocumentLanguage, (e) => this.setTextDocumentLanguage(e));
        setupOutputHandlers();
    }

    private setTextDocumentLanguage(languageStr: string): void {
        const cppSettings: CppSettings = new CppSettings();
        if (cppSettings.autoAddFileAssociations) {
            const is_c: boolean = languageStr.startsWith("c;");
            languageStr = languageStr.substr(is_c ? 2 : 1);
            this.addFileAssociations(languageStr, is_c);
        }
    }

    private associations_for_did_change?: Set<string>;

    /**
     * listen for file created/deleted events under the ${workspaceFolder} folder
     */
    private registerFileWatcher(): void {
        console.assert(this.languageClient !== undefined, "This method must not be called until this.languageClient is set in \"onReady\"");

        if (this.rootFolder) {
            // WARNING: The default limit on Linux is 8k, so for big directories, this can cause file watching to fail.
            this.rootPathFileWatcher = vscode.workspace.createFileSystemWatcher(
                "**/*",
                false /* ignoreCreateEvents */,
                false /* ignoreChangeEvents */,
                false /* ignoreDeleteEvents */);

            this.rootPathFileWatcher.onDidCreate((uri) => {
                this.languageClient.sendNotification(FileCreatedNotification, { uri: uri.toString() });
            });

            // TODO: Handle new associations without a reload.
            this.associations_for_did_change = new Set<string>(["c", "i", "cpp", "cc", "cxx", "c++", "cp", "hpp", "hh", "hxx", "h++", "hp", "h", "ii", "ino", "inl", "ipp", "tcc", "idl"]);
            const assocs: any = new OtherSettings().filesAssociations;
            for (const assoc in assocs) {
                const dotIndex: number = assoc.lastIndexOf('.');
                if (dotIndex !== -1) {
                    const ext: string = assoc.substr(dotIndex + 1);
                    this.associations_for_did_change.add(ext);
                }
            }
            this.rootPathFileWatcher.onDidChange((uri) => {
                const dotIndex: number = uri.fsPath.lastIndexOf('.');
                if (dotIndex !== -1) {
                    const ext: string = uri.fsPath.substr(dotIndex + 1);
                    if (this.associations_for_did_change?.has(ext)) {
                        // VS Code has a bug that causes onDidChange events to happen to files that aren't changed,
                        // which causes a large backlog of "files to parse" to accumulate.
                        // We workaround this via only sending the change message if the modified time is within 10 seconds.
                        const mtime: Date = fs.statSync(uri.fsPath).mtime;
                        const duration: number = Date.now() - mtime.getTime();
                        if (duration < 10000) {
                            this.languageClient.sendNotification(FileChangedNotification, { uri: uri.toString() });
                        }
                    }
                }
            });

            this.rootPathFileWatcher.onDidDelete((uri) => {
                this.languageClient.sendNotification(FileDeletedNotification, { uri: uri.toString() });
            });

            this.disposables.push(this.rootPathFileWatcher);
        } else {
            this.rootPathFileWatcher = undefined;
        }
    }

    /**
     * handle notifications coming from the language server
     */

    public addFileAssociations(fileAssociations: string, is_c: boolean): void {
        const settings: OtherSettings = new OtherSettings();
        const assocs: any = settings.filesAssociations;

        const filesAndPaths: string[] = fileAssociations.split(";");
        let foundNewAssociation: boolean = false;
        for (let i: number = 0; i < filesAndPaths.length; ++i) {
            const fileAndPath: string[] = filesAndPaths[i].split("@");
            // Skip empty or malformed
            if (fileAndPath.length === 2) {
                const file: string = fileAndPath[0];
                const filePath: string = fileAndPath[1];
                if ((file in assocs) || (("**/" + file) in assocs)) {
                    continue; // File already has an association.
                }
                const j: number = file.lastIndexOf('.');
                if (j !== -1) {
                    const ext: string = file.substr(j);
                    if ((("*" + ext) in assocs) || (("**/*" + ext) in assocs)) {
                        continue; // Extension already has an association.
                    }
                }
                let foundGlobMatch: boolean = false;
                for (const assoc in assocs) {
                    if (minimatch(filePath, assoc)) {
                        foundGlobMatch = true;
                        break; // Assoc matched a glob pattern.
                    }
                }
                if (foundGlobMatch) {
                    continue;
                }
                assocs[file] = is_c ? "c" : "cpp";
                foundNewAssociation = true;
            }
        }
        if (foundNewAssociation) {
            settings.filesAssociations = assocs;
        }
    }

    private updateStatus(notificationBody: ReportStatusNotificationBody): void {
        const message: string = notificationBody.status;
        util.setProgress(util.getProgressExecutableSuccess());
        const testHook: TestHook = getTestHook();
        if (message.endsWith("Indexing...")) {
            this.model.isTagParsing.Value = true;
            const status: IntelliSenseStatus = { status: Status.TagParsingBegun };
            testHook.updateStatus(status);
        } else if (message.endsWith("Updating IntelliSense...")) {
            timeStamp = Date.now();
            this.model.isUpdatingIntelliSense.Value = true;
            const status: IntelliSenseStatus = { status: Status.IntelliSenseCompiling };
            testHook.updateStatus(status);
        } else if (message.endsWith("IntelliSense Ready")) {
            const settings: CppSettings = new CppSettings();
            if (settings.loggingLevel === "Debug") {
                const out: logger.Logger = logger.getOutputChannelLogger();
                const duration: number = Date.now() - timeStamp;
                out.appendLine(localize("update.intellisense.time", "Update IntelliSense time (sec): {0}", duration / 1000));
            }
            this.model.isUpdatingIntelliSense.Value = false;
            const status: IntelliSenseStatus = { status: Status.IntelliSenseReady };
            testHook.updateStatus(status);
        } else if (message.endsWith("Ready")) { // Tag Parser Ready
            this.model.isTagParsing.Value = false;
            const status: IntelliSenseStatus = { status: Status.TagParsingDone };
            testHook.updateStatus(status);
            util.setProgress(util.getProgressParseRootSuccess());
        } else if (message.includes("Squiggles Finished - File name:")) {
            const index: number = message.lastIndexOf(":");
            const name: string = message.substring(index + 2);
            const status: IntelliSenseStatus = { status: Status.IntelliSenseReady, filename: name };
            testHook.updateStatus(status);
        } else if (message.endsWith("No Squiggles")) {
            util.setIntelliSenseProgress(util.getProgressIntelliSenseNoSquiggles());
        } else if (message.endsWith("Unresolved Headers")) {
            if (notificationBody.workspaceFolderUri) {
                const client: DefaultClient = <DefaultClient>clientCollection.getClientFor(vscode.Uri.file(notificationBody.workspaceFolderUri));
                if (!client.configuration.CurrentConfiguration?.configurationProvider) {
                    const showIntelliSenseFallbackMessage: PersistentState<boolean> = new PersistentState<boolean>("CPP.showIntelliSenseFallbackMessage", true);
                    if (showIntelliSenseFallbackMessage.Value) {
                        ui.showConfigureIncludePathMessage(() => {
                            const configJSON: string = localize("configure.json.button", "Configure (JSON)");
                            const configUI: string = localize("configure.ui.button", "Configure (UI)");
                            const dontShowAgain: string = localize("dont.show.again", "Don't Show Again");
                            const fallbackMsg: string = client.configuration.VcpkgInstalled ?
                                localize("update.your.intellisense.settings", "Update your IntelliSense settings or use Vcpkg to install libraries to help find missing headers.") :
                                localize("configure.your.intellisense.settings", "Configure your IntelliSense settings to help find missing headers.");
                            return vscode.window.showInformationMessage(fallbackMsg, configJSON, configUI, dontShowAgain).then((value) => {
                                switch (value) {
                                    case configJSON:
                                        vscode.commands.getCommands(true).then((commands: string[]) => {
                                            if (commands.indexOf("workbench.action.problems.focus") >= 0) {
                                                vscode.commands.executeCommand("workbench.action.problems.focus");
                                            }
                                        });
                                        client.handleConfigurationEditJSONCommand();
                                        telemetry.logLanguageServerEvent("SettingsCommand", { "toast": "json" }, undefined);
                                        break;
                                    case configUI:
                                        vscode.commands.getCommands(true).then((commands: string[]) => {
                                            if (commands.indexOf("workbench.action.problems.focus") >= 0) {
                                                vscode.commands.executeCommand("workbench.action.problems.focus");
                                            }
                                        });
                                        client.handleConfigurationEditUICommand();
                                        telemetry.logLanguageServerEvent("SettingsCommand", { "toast": "ui" }, undefined);
                                        break;
                                    case dontShowAgain:
                                        showIntelliSenseFallbackMessage.Value = false;
                                        break;
                                }
                                return true;
                            });
                        },
                        () => showIntelliSenseFallbackMessage.Value = false);
                    }
                }
            }
        }
    }

    private updateTagParseStatus(notificationBody: LocalizeStringParams): void {
        this.model.tagParserStatus.Value = util.getLocalizedString(notificationBody);
    }

    private updateInactiveRegions(params: InactiveRegionParams): void {
        const settings: CppSettings = new CppSettings(this.RootUri);
        const opacity: number | undefined = settings.inactiveRegionOpacity;
        if (opacity !== null && opacity !== undefined) {
            let backgroundColor: string | undefined = settings.inactiveRegionBackgroundColor;
            if (backgroundColor === "") {
                backgroundColor = undefined;
            }
            let color: string | undefined = settings.inactiveRegionForegroundColor;
            if (color === "") {
                color = undefined;
            }
            const decoration: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
                opacity: opacity.toString(),
                backgroundColor: backgroundColor,
                color: color,
                rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
            });
            // We must convert to vscode.Ranges in order to make use of the API's
            const ranges: vscode.Range[] = [];
            params.regions.forEach(element => {
                const newRange: vscode.Range = new vscode.Range(element.startLine, 0, element.endLine, 0);
                ranges.push(newRange);
            });
            // Find entry for cached file and act accordingly
            const valuePair: DecorationRangesPair | undefined = this.inactiveRegionsDecorations.get(params.uri);
            if (valuePair) {
                // Disposing of and resetting the decoration will undo previously applied text decorations
                valuePair.decoration.dispose();
                valuePair.decoration = decoration;
                // As vscode.TextEditor.setDecorations only applies to visible editors, we must cache the range for when another editor becomes visible
                valuePair.ranges = ranges;
            } else { // The entry does not exist. Make a new one
                const toInsert: DecorationRangesPair = {
                    decoration: decoration,
                    ranges: ranges
                };
                this.inactiveRegionsDecorations.set(params.uri, toInsert);
            }
            if (settings.dimInactiveRegions && params.fileVersion === this.openFileVersions.get(params.uri)) {
                // Apply the decorations to all *visible* text editors
                const editors: vscode.TextEditor[] = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === params.uri);
                for (const e of editors) {
                    e.setDecorations(decoration, ranges);
                }
            }
        }
    }

    private promptCompileCommands(params: CompileCommandsPaths): void {
        if (!params.workspaceFolderUri) {
            return;
        }
        const client: DefaultClient = <DefaultClient>clientCollection.getClientFor(vscode.Uri.file(params.workspaceFolderUri));
        if (client.configuration.CurrentConfiguration?.compileCommands || client.configuration.CurrentConfiguration?.configurationProvider) {
            return;
        }
        const rootFolder: vscode.WorkspaceFolder | undefined = client.RootFolder;
        if (!rootFolder) {
            return;
        }

        const ask: PersistentFolderState<boolean> = new PersistentFolderState<boolean>("CPP.showCompileCommandsSelection", true, rootFolder);
        if (!ask.Value) {
            return;
        }

        const aCompileCommandsFile: string = localize("a.compile.commands.file", "a compile_commands.json file");
        const compileCommandStr: string = params.paths.length > 1 ? aCompileCommandsFile : params.paths[0];
        const message: string = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1)
            ? localize("auto-configure.intellisense.folder", "Would you like to use {0} to auto-configure IntelliSense for the '{1}' folder?", compileCommandStr, client.Name)
            : localize("auto-configure.intellisense.this.folder", "Would you like to use {0} to auto-configure IntelliSense for this folder?", compileCommandStr);

        ui.showConfigureCompileCommandsMessage(() => {
            const yes: string = localize("yes.button", "Yes");
            const no: string = localize("no.button", "No");
            const askLater: string = localize("ask.me.later.button", "Ask Me Later");
            return vscode.window.showInformationMessage(message, yes, no, askLater).then(async (value) => {
                switch (value) {
                    case yes:
                        if (params.paths.length > 1) {
                            const index: number = await ui.showCompileCommands(params.paths);
                            if (index < 0) {
                                return false;
                            }
                            this.configuration.setCompileCommands(params.paths[index]);
                        } else {
                            this.configuration.setCompileCommands(params.paths[0]);
                        }
                        return true;
                    case askLater:
                        break;
                    case no:
                        ask.Value = false;
                        break;
                }
                return false;
            });
        },
        () => ask.Value = false);
    }

    /**
     * requests to the language server
     */
    public requestSwitchHeaderSource(rootPath: string, fileName: string): Thenable<string> {
        const params: SwitchHeaderSourceParams = {
            switchHeaderSourceFileName: fileName,
            workspaceFolderUri: rootPath
        };
        return this.requestWhenReady(() => this.languageClient.sendRequest(SwitchHeaderSourceRequest, params));
    }

    /**
     * notifications to the language server
     */
    public activeDocumentChanged(document: vscode.TextDocument): void {
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(ActiveDocumentChangeNotification, this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document));
        });
    }

    /**
     * enable UI updates from this client and resume tag parsing on the server.
     */
    public activate(): void {
        this.model.activate();
        this.resumeParsing();
    }

    public selectionChanged(selection: Range): void {
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(TextEditorSelectionChangeNotification, selection);
        });
    }

    public resetDatabase(): void {
        this.notifyWhenReady(() => this.languageClient.sendNotification(ResetDatabaseNotification));
    }

    /**
     * disable UI updates from this client and pause tag parsing on the server.
     */
    public deactivate(): void {
        this.model.deactivate();
    }

    public pauseParsing(): void {
        this.notifyWhenReady(() => this.languageClient.sendNotification(PauseParsingNotification));
    }

    public resumeParsing(): void {
        this.notifyWhenReady(() => this.languageClient.sendNotification(ResumeParsingNotification));
    }

    private doneInitialCustomBrowseConfigurationCheck: Boolean = false;

    private onConfigurationsChanged(configurations: configs.Configuration[]): void {
        const params: CppPropertiesParams = {
            configurations: configurations,
            currentConfiguration: this.configuration.CurrentConfigurationIndex,
            workspaceFolderUri: this.RootPath,
            isReady: true
        };
        // Separate compiler path and args before sending to language client
        params.configurations.forEach((c: configs.Configuration) => {
            const compilerPathAndArgs: util.CompilerPathAndArgs =
                util.extractCompilerPathAndArgs(c.compilerPath, c.compilerArgs);
            c.compilerPath = compilerPathAndArgs.compilerPath;
            c.compilerArgs = compilerPathAndArgs.additionalArgs;
        });
        let sendLastCustomBrowseConfiguration: boolean = false;
        const rootFolder: vscode.WorkspaceFolder | undefined = this.RootFolder;
        if (!rootFolder) {
            this.languageClient.sendNotification(ChangeCppPropertiesNotification, params);
        } else {
            const lastCustomBrowseConfigurationProviderId: PersistentFolderState<string | undefined> = new PersistentFolderState<string | undefined>("CPP.lastCustomBrowseConfigurationProviderId", undefined, rootFolder);
            const lastCustomBrowseConfiguration: PersistentFolderState<WorkspaceBrowseConfiguration | undefined> = new PersistentFolderState<WorkspaceBrowseConfiguration | undefined>("CPP.lastCustomBrowseConfiguration", undefined, rootFolder);
            if (!this.doneInitialCustomBrowseConfigurationCheck) {
                // Send the last custom browse configuration we received from this provider.
                // This ensures we don't start tag parsing without it, and undo'ing work we have to re-do when the (likely same) browse config arrives
                // Should only execute on launch, for the initial delivery of configurations
                if (isSameProviderExtensionId(lastCustomBrowseConfigurationProviderId.Value, configurations[params.currentConfiguration].configurationProvider)) {
                    if (lastCustomBrowseConfiguration.Value) {
                        sendLastCustomBrowseConfiguration = true;
                        params.isReady = false;
                    }
                }
                this.doneInitialCustomBrowseConfigurationCheck = true;
            }
            this.languageClient.sendNotification(ChangeCppPropertiesNotification, params);
            if (sendLastCustomBrowseConfiguration) {
                this.sendCustomBrowseConfiguration(lastCustomBrowseConfiguration.Value, lastCustomBrowseConfigurationProviderId.Value);
            }
        }
        const configName: string | undefined = configurations[params.currentConfiguration].name ?? "";
        this.model.activeConfigName.setValueIfActive(configName);
        const newProvider: string | undefined = this.configuration.CurrentConfigurationProvider;
        if (!isSameProviderExtensionId(newProvider, this.configurationProvider)) {
            if (this.configurationProvider) {
                this.clearCustomBrowseConfiguration();
            }
            this.configurationProvider = newProvider;
            this.updateCustomBrowseConfiguration();
            this.updateCustomConfigurations();
        }
    }

    private onSelectedConfigurationChanged(index: number): void {
        const params: FolderSelectedSettingParams = {
            currentConfiguration: index,
            workspaceFolderUri: this.RootPath
        };
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(ChangeSelectedSettingNotification, params);
            let configName: string = "";
            if (this.configuration.ConfigurationNames) {
                configName = this.configuration.ConfigurationNames[index];
            }
            this.model.activeConfigName.Value = configName;
            this.configuration.onDidChangeSettings();
        });
    }

    private onCompileCommandsChanged(path: string): void {
        const params: FileChangedParams = {
            uri: vscode.Uri.file(path).toString(),
            workspaceFolderUri: this.RootPath
        };
        this.notifyWhenReady(() => this.languageClient.sendNotification(ChangeCompileCommandsNotification, params));
    }

    private isSourceFileConfigurationItem(input: any): input is SourceFileConfigurationItem {
        return (input && (util.isString(input.uri) || util.isUri(input.uri)) &&
            input.configuration &&
            util.isArrayOfString(input.configuration.includePath) &&
            util.isArrayOfString(input.configuration.defines) &&
            util.isString(input.configuration.intelliSenseMode) &&
            util.isString(input.configuration.standard) &&
            util.isOptionalString(input.configuration.compilerPath) &&
            util.isOptionalArrayOfString(input.configuration.compilerArgs) &&
            util.isOptionalArrayOfString(input.configuration.forcedInclude));
    }

    private sendCustomConfigurations(configs: any): void {
        // configs is marked as 'any' because it is untrusted data coming from a 3rd-party. We need to sanitize it before sending it to the language server.
        if (!configs || !(configs instanceof Array)) {
            console.warn("discarding invalid SourceFileConfigurationItems[]: " + configs);
            return;
        }

        const settings: CppSettings = new CppSettings();
        const out: logger.Logger = logger.getOutputChannelLogger();
        if (settings.loggingLevel === "Debug") {
            out.appendLine(localize("configurations.received", "Custom configurations received:"));
        }
        const sanitized: SourceFileConfigurationItemAdapter[] = [];
        configs.forEach(item => {
            if (this.isSourceFileConfigurationItem(item)) {
                if (settings.loggingLevel === "Debug") {
                    out.appendLine(`  uri: ${item.uri.toString()}`);
                    out.appendLine(`  config: ${JSON.stringify(item.configuration, null, 2)}`);
                }
                if (item.configuration.includePath.some(path => path.endsWith('**'))) {
                    console.warn("custom include paths should not use recursive includes ('**')");
                }
                // Separate compiler path and args before sending to language client
                const itemConfig: util.Mutable<SourceFileConfiguration> = {...item.configuration};
                if (util.isString(itemConfig.compilerPath)) {
                    const compilerPathAndArgs: util.CompilerPathAndArgs = util.extractCompilerPathAndArgs(
                        itemConfig.compilerPath,
                        util.isArrayOfString(itemConfig.compilerArgs) ? itemConfig.compilerArgs : undefined);
                    itemConfig.compilerPath = compilerPathAndArgs.compilerPath;
                    itemConfig.compilerArgs = compilerPathAndArgs.additionalArgs;
                }
                sanitized.push({
                    uri: item.uri.toString(),
                    configuration: itemConfig
                });
            } else {
                console.warn("discarding invalid SourceFileConfigurationItem: " + item);
            }
        });

        if (sanitized.length === 0) {
            return;
        }

        const params: CustomConfigurationParams = {
            configurationItems: sanitized,
            workspaceFolderUri: this.RootPath
        };

        this.languageClient.sendNotification(CustomConfigurationNotification, params);
    }

    private sendCustomBrowseConfiguration(config: any, providerId?: string, timeoutOccured?: boolean): void {
        const rootFolder: vscode.WorkspaceFolder | undefined = this.RootFolder;
        if (!rootFolder) {
            return;
        }
        const lastCustomBrowseConfiguration: PersistentFolderState<WorkspaceBrowseConfiguration | undefined> = new PersistentFolderState<WorkspaceBrowseConfiguration | undefined>("CPP.lastCustomBrowseConfiguration", undefined, rootFolder);
        const lastCustomBrowseConfigurationProviderId: PersistentFolderState<string | undefined> = new PersistentFolderState<string | undefined>("CPP.lastCustomBrowseConfigurationProviderId", undefined, rootFolder);
        let sanitized: util.Mutable<WorkspaceBrowseConfiguration>;

        // This while (true) is here just so we can break out early if the config is set on error
        while (true) {
            // config is marked as 'any' because it is untrusted data coming from a 3rd-party. We need to sanitize it before sending it to the language server.
            if (timeoutOccured || !config || config instanceof Array) {
                if (!timeoutOccured) {
                    console.log("Received an invalid browse configuration from configuration provider.");
                }
                const configValue: WorkspaceBrowseConfiguration | undefined = lastCustomBrowseConfiguration.Value;
                if (configValue) {
                    sanitized = configValue;
                    console.log("Falling back to last received browse configuration: ", JSON.stringify(sanitized, null, 2));
                    break;
                }
                console.log("No browse configuration is available.");
                return;
            }

            sanitized = {...<WorkspaceBrowseConfiguration>config};
            if (!util.isArrayOfString(sanitized.browsePath) ||
                !util.isOptionalString(sanitized.compilerPath) ||
                !util.isOptionalArrayOfString(sanitized.compilerArgs) ||
                !util.isOptionalString(sanitized.standard) ||
                !util.isOptionalString(sanitized.windowsSdkVersion)) {
                console.log("Received an invalid browse configuration from configuration provider.");
                const configValue: WorkspaceBrowseConfiguration | undefined = lastCustomBrowseConfiguration.Value;
                if (configValue) {
                    sanitized = configValue;
                    console.log("Falling back to last received browse configuration: ", JSON.stringify(sanitized, null, 2));
                    break;
                }
                return;
            }

            const settings: CppSettings = new CppSettings();
            if (settings.loggingLevel === "Debug") {
                const out: logger.Logger = logger.getOutputChannelLogger();
                out.appendLine(localize("browse.configuration.received", "Custom browse configuration received: {0}", JSON.stringify(sanitized, null, 2)));
            }

            // Separate compiler path and args before sending to language client
            if (util.isString(sanitized.compilerPath)) {
                const compilerPathAndArgs: util.CompilerPathAndArgs = util.extractCompilerPathAndArgs(
                    sanitized.compilerPath,
                    util.isArrayOfString(sanitized.compilerArgs) ? sanitized.compilerArgs : undefined);
                sanitized.compilerPath = compilerPathAndArgs.compilerPath;
                sanitized.compilerArgs = compilerPathAndArgs.additionalArgs;
            }

            lastCustomBrowseConfiguration.Value = sanitized;
            if (!providerId) {
                lastCustomBrowseConfigurationProviderId.setDefault();
            } else {
                lastCustomBrowseConfigurationProviderId.Value = providerId;
            }
            break;
        }

        const params: CustomBrowseConfigurationParams = {
            browseConfiguration: sanitized,
            workspaceFolderUri: this.RootPath
        };

        this.languageClient.sendNotification(CustomBrowseConfigurationNotification, params);
    }

    private clearCustomConfigurations(): void {
        const params: WorkspaceFolderParams = {
            workspaceFolderUri: this.RootPath
        };
        this.notifyWhenReady(() => this.languageClient.sendNotification(ClearCustomConfigurationsNotification, params));
    }

    private clearCustomBrowseConfiguration(): void {
        const params: WorkspaceFolderParams = {
            workspaceFolderUri: this.RootPath
        };
        this.notifyWhenReady(() => this.languageClient.sendNotification(ClearCustomBrowseConfigurationNotification, params));
    }

    /**
     * command handlers
     */
    public handleConfigurationSelectCommand(): void {
        this.notifyWhenReady(() => {
            const configNames: string[] | undefined = this.configuration.ConfigurationNames;
            if (configNames) {
                ui.showConfigurations(configNames)
                    .then((index: number) => {
                        if (index < 0) {
                            return;
                        }
                        this.configuration.select(index);
                    });
            }
        });
    }

    public handleConfigurationProviderSelectCommand(): void {
        this.notifyWhenReady(() => {
            ui.showConfigurationProviders(this.configuration.CurrentConfigurationProvider)
                .then(extensionId => {
                    if (extensionId === undefined) {
                        // operation was canceled.
                        return;
                    }
                    this.configuration.updateCustomConfigurationProvider(extensionId)
                        .then(() => {
                            if (extensionId) {
                                const provider: CustomConfigurationProvider1 | undefined = getCustomConfigProviders().get(extensionId);
                                this.updateCustomBrowseConfiguration(provider);
                                this.updateCustomConfigurations(provider);
                                telemetry.logLanguageServerEvent("customConfigurationProvider", { "providerId": extensionId });
                            } else {
                                this.clearCustomConfigurations();
                                this.clearCustomBrowseConfiguration();
                            }
                        });
                });
        });
    }

    public handleShowParsingCommands(): void {
        this.notifyWhenReady(() => {
            ui.showParsingCommands()
                .then((index: number) => {
                    if (index === 0) {
                        this.pauseParsing();
                    } else if (index === 1) {
                        this.resumeParsing();
                    }
                });
        });
    }

    public handleConfigurationEditCommand(): void {
        this.notifyWhenReady(() => this.configuration.handleConfigurationEditCommand(undefined, vscode.window.showTextDocument));
    }

    public handleConfigurationEditJSONCommand(): void {
        this.notifyWhenReady(() => this.configuration.handleConfigurationEditJSONCommand(undefined, vscode.window.showTextDocument));
    }

    public handleConfigurationEditUICommand(): void {
        this.notifyWhenReady(() => this.configuration.handleConfigurationEditUICommand(undefined, vscode.window.showTextDocument));
    }

    public handleAddToIncludePathCommand(path: string): void {
        this.notifyWhenReady(() => this.configuration.addToIncludePathCommand(path));
    }

    public onInterval(): void {
        // These events can be discarded until the language client is ready.
        // Don't queue them up with this.notifyWhenReady calls.
        if (this.innerLanguageClient !== undefined && this.configuration !== undefined) {
            this.languageClient.sendNotification(IntervalTimerNotification);
            this.configuration.checkCppProperties();
        }
    }

    public dispose(): Thenable<void> {
        const promise: Thenable<void> = (this.languageClient && clientCollection.Count === 0) ? this.languageClient.stop() : Promise.resolve();
        return promise.then(() => {
            this.disposables.forEach((d) => d.dispose());
            this.disposables = [];
            if (this.codeFoldingProviderDisposable) {
                this.codeFoldingProviderDisposable.dispose();
                this.codeFoldingProviderDisposable = undefined;
            }
            if (this.semanticTokensProviderDisposable) {
                this.semanticTokensProviderDisposable.dispose();
                this.semanticTokensProviderDisposable = undefined;
            }
            this.model.dispose();
        });
    }

    public handleReferencesIcon(): void {
        this.notifyWhenReady(() => {
            const cancelling: boolean = referencesPendingCancellations.length > 0;
            if (!cancelling) {
                workspaceReferences.UpdateProgressUICounter(this.model.referencesCommandMode.Value);
                if (this.ReferencesCommandMode === refs.ReferencesCommandMode.Find) {
                    if (!workspaceReferences.referencesRequestPending) {
                        if (workspaceReferences.referencesRequestHasOccurred) {
                            // References are not usable if a references request is pending,
                            // So after the initial request, we don't send a 2nd references request until the next request occurs.
                            if (!workspaceReferences.referencesRefreshPending) {
                                workspaceReferences.referencesRefreshPending = true;
                                vscode.commands.executeCommand("references-view.refresh");
                            }
                        } else {
                            workspaceReferences.referencesRequestHasOccurred = true;
                            workspaceReferences.referencesRequestPending = true;
                            this.languageClient.sendNotification(RequestReferencesNotification, false);
                        }
                    }
                }
            }
        });
    }

    public cancelReferences(): void {
        referencesParams = undefined;
        renamePending = false;
        if (referencesRequestPending || workspaceReferences.symbolSearchInProgress) {
            const cancelling: boolean = referencesPendingCancellations.length > 0;
            referencesPendingCancellations.push({ reject: () => {}, callback: () => {} });
            if (!cancelling) {
                workspaceReferences.referencesCanceled = true;
                languageClient.sendNotification(CancelReferencesNotification);
            }
        }
    }

    private handleReferencesProgress(notificationBody: refs.ReportReferencesProgressNotification): void {
        workspaceReferences.handleProgress(notificationBody);
    }

    private processReferencesResult(referencesResult: refs.ReferencesResult): void {
        workspaceReferences.processResults(referencesResult);
    }

    public setReferencesCommandMode(mode: refs.ReferencesCommandMode): void {
        this.model.referencesCommandMode.Value = mode;
    }

    public abortRequest(id: number): void {
        const params: AbortRequestParams = {
            id: id
        };
        languageClient.sendNotification(AbortRequestNotification, params);
    }
}

function getLanguageServerFileName(): string {
    let extensionProcessName: string = 'cpptools';
    const plat: NodeJS.Platform = process.platform;
    if (plat === 'win32') {
        extensionProcessName += '.exe';
    } else if (plat !== 'linux' && plat !== 'darwin') {
        throw "Invalid Platform";
    }
    return path.resolve(util.getExtensionFilePath("bin"), extensionProcessName);
}

class NullClient implements Client {
    private booleanEvent = new vscode.EventEmitter<boolean>();
    private stringEvent = new vscode.EventEmitter<string>();
    private referencesCommandModeEvent = new vscode.EventEmitter<refs.ReferencesCommandMode>();

    public get TagParsingChanged(): vscode.Event<boolean> { return this.booleanEvent.event; }
    public get IntelliSenseParsingChanged(): vscode.Event<boolean> { return this.booleanEvent.event; }
    public get ReferencesCommandModeChanged(): vscode.Event<refs.ReferencesCommandMode> { return this.referencesCommandModeEvent.event; }
    public get TagParserStatusChanged(): vscode.Event<string> { return this.stringEvent.event; }
    public get ActiveConfigChanged(): vscode.Event<string> { return this.stringEvent.event; }
    RootPath: string = "/";
    RootUri?: vscode.Uri = vscode.Uri.file("/");
    Name: string = "(empty)";
    TrackedDocuments = new Set<vscode.TextDocument>();
    onDidChangeSettings(event: vscode.ConfigurationChangeEvent, isFirstClient: boolean): { [key: string]: string } { return {}; }
    onDidOpenTextDocument(document: vscode.TextDocument): void {}
    onDidCloseTextDocument(document: vscode.TextDocument): void {}
    onDidChangeVisibleTextEditors(editors: vscode.TextEditor[]): void {}
    onDidChangeTextDocument(textDocumentChangeEvent: vscode.TextDocumentChangeEvent): void {}
    onRegisterCustomConfigurationProvider(provider: CustomConfigurationProvider1): Thenable<void> { return Promise.resolve(); }
    updateCustomConfigurations(requestingProvider?: CustomConfigurationProvider1): Thenable<void> { return Promise.resolve(); }
    updateCustomBrowseConfiguration(requestingProvider?: CustomConfigurationProvider1): Thenable<void> { return Promise.resolve(); }
    provideCustomConfiguration(docUri: vscode.Uri, requestFile?: string): Promise<void> { return Promise.resolve(); }
    logDiagnostics(): Promise<void> { return Promise.resolve(); }
    rescanFolder(): Promise<void> { return Promise.resolve(); }
    toggleReferenceResultsView(): void {}
    setCurrentConfigName(configurationName: string): Thenable<void> { return Promise.resolve(); }
    getCurrentConfigName(): Thenable<string> { return Promise.resolve(""); }
    getCurrentConfigCustomVariable(variableName: string): Thenable<string> { return Promise.resolve(""); }
    getVcpkgInstalled(): Thenable<boolean> { return Promise.resolve(false); }
    getVcpkgEnabled(): Thenable<boolean> { return Promise.resolve(false); }
    getCurrentCompilerPathAndArgs(): Thenable<util.CompilerPathAndArgs | undefined> { return Promise.resolve(undefined); }
    getKnownCompilers(): Thenable<configs.KnownCompiler[] | undefined> { return Promise.resolve([]); }
    takeOwnership(document: vscode.TextDocument): void {}
    queueTask<T>(task: () => Thenable<T>): Thenable<T> { return task(); }
    requestWhenReady<T>(request: () => Thenable<T>): Thenable<T> { return request(); }
    notifyWhenReady(notify: () => void): void {}
    requestSwitchHeaderSource(rootPath: string, fileName: string): Thenable<string> { return Promise.resolve(""); }
    activeDocumentChanged(document: vscode.TextDocument): void {}
    activate(): void {}
    selectionChanged(selection: Range): void {}
    resetDatabase(): void {}
    deactivate(): void {}
    pauseParsing(): void {}
    resumeParsing(): void {}
    handleConfigurationSelectCommand(): void {}
    handleConfigurationProviderSelectCommand(): void {}
    handleShowParsingCommands(): void {}
    handleReferencesIcon(): void {}
    handleConfigurationEditCommand(): void {}
    handleConfigurationEditJSONCommand(): void {}
    handleConfigurationEditUICommand(): void {}
    handleAddToIncludePathCommand(path: string): void {}
    onInterval(): void {}
    dispose(): Thenable<void> {
        this.booleanEvent.dispose();
        this.stringEvent.dispose();
        return Promise.resolve();
    }
    addFileAssociations(fileAssociations: string, is_c: boolean): void {}
    sendDidChangeSettings(settings: any): void {}
}
