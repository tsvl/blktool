'use strict';

import * as vscode from 'vscode';
import * as path from 'path';

import { readFile } from 'fs';

import * as pegjs from 'pegjs';

async function getParser(): Promise<any> {
	return new Promise<any>((resolve, reject) => {
		readFile(`${__dirname}/../../blk.pegjs`, (err, content) => {
			if (!!err) {
				reject(err);
			}
			else {
				resolve(pegjs.generate(content.toString()));
			}
		});
	});
}

async function getFileContent(filename: string): Promise<string> {
  // console.log({ filename });
  return new Promise<any>((resolve, reject) => {
		readFile(filename, (err, content) => {
			if (!!err) {
				reject("");
			}
			else {
				resolve(content.toString());
			}
		});
	});
}

export namespace blk
{
  let g_diagnostic_collection: vscode.DiagnosticCollection = null;

  export function setDiagnosticCollection(diagnosticCollection: vscode.DiagnosticCollection)
  {
    g_diagnostic_collection = diagnosticCollection;
  }

  export async function getIncludes(document: vscode.TextDocument, resolveBlkPath: (text: string, rootPath: string) => string)
  {
    let parser = await getParser();

    let conf = vscode.workspace.getConfiguration("blktool");
    let readParams = conf.get<string[]>('dependencyTree.readParams');
    for (let i = 0; i < readParams.length; ++i)
    {
      readParams[i] = '/' + readParams[i];
    }
    console.log({readParams});

    let fullText = document.getText(/* range */);

    let includesTree = {
      name: path.basename(document.fileName),
      children: []
    };

    function getIncludesFromBlock(block: any, added = {}, rootBlockPath = "")
    {
      let blockPath = rootBlockPath + block.name;
      // console.log({blockPath});

      let includes = [];
      for (let i of block.includes)
      {
        if (added[i.value])
          continue;
        includes.push({ name: path.basename(i.value), value: `include "${i.value}"`, blockPath });
        added[i.value] = true;
      }

      for (let param of block.params)
      {
        let paramPath = blockPath + '/' + param.value[0];
        if (readParams.indexOf(paramPath) >= 0)
        {
          includes.push({ name: path.basename(param.value[2].replace(/["']/g, '')), value: param.value[2], blockPath });
        }
      }

      for (let subblock of block.blocks)
      {
        includes = includes.concat(getIncludesFromBlock(subblock, added, blockPath + '/'));
      }
      return includes;
    }

    async function mkNode(inc: any, rootPath: string)
    {
      let node = { name: inc.name, value: inc.value, children: [] };
      let fullPath = resolveBlkPath(inc.value, rootPath);
      node.value = fullPath;

      // console.log({inc, fullPath});

      let blkContent = await getFileContent(fullPath);

      let blkRoot = parser.parse(blkContent);
      let rootIncludes = getIncludesFromBlock(blkRoot, {}, inc.blockPath);
      for (let i of rootIncludes)
      {
        let childNode = await mkNode(i, path.dirname(fullPath));
        node.children.push(childNode);
      }

      return Promise.resolve(node);
    }

    try
    {
      let blkRoot = parser.parse(fullText);
      console.log({blkRoot});
      let rootIncludes = getIncludesFromBlock(blkRoot);
      for (let i of rootIncludes)
      {
        let node = await mkNode(i, path.dirname(document.uri.fsPath));
        includesTree.children.push(node);
      }
    }
    catch (err)
    {
      console.log({error: err.message});
    }

    return Promise.resolve(includesTree);
  }

  export class RangeFormattingEditProvider implements vscode.DocumentRangeFormattingEditProvider
  {
    onlyValidate = false;
    edits: vscode.TextEdit[] = [];

    addEdit(document: vscode.TextDocument, from: number, to: number, replaceWith: string)
    {
      if (this.onlyValidate)
        return;

      let range = new vscode.Range(document.positionAt(from), document.positionAt(to));
      if (document.validateRange(range))
        this.edits.push(vscode.TextEdit.replace(range, replaceWith));
    }

    addInsert(document: vscode.TextDocument, at: number, text: string)
    {
      if (!this.onlyValidate)
        this.edits.push(vscode.TextEdit.insert(document.positionAt(at), text));
    }

    async provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): Promise<vscode.TextEdit[]>
    {
      this.edits = [];

      let errors: vscode.Diagnostic[] = [];

      g_diagnostic_collection.clear();

      let fullText = document.getText(/* range */);

      let parser = await getParser();

      // Use editor's indentation settings
      const tabSize = options.tabSize || 2;
      const insertSpaces = options.insertSpaces !== undefined ? options.insertSpaces : true;
      const indentWith = insertSpaces ? ' '.repeat(tabSize) : '\t';

      // Get the user's formatting preferences
      let conf = vscode.workspace.getConfiguration("blktool");
      let useSpaces = conf.get<boolean>('formatter.useSpaces', true);
      let maxPreservedNewlines = conf.get<number>('formatter.maxPreservedNewlines', 2);

      // Define spacing based on user preferences
      const equalSpacing = useSpaces ? ' = ' : '=';
      const blockSpacing = useSpaces ? ' ' : '';

      try {
        let blkRoot = parser.parse(fullText);

        let formatBlock = function (block, level) {
          let blockLine = block.location.start.line;
          let paramLinePrev = -1;
          for (let i = 0; i < block.params.length; ++i) {
            let param = block.params[i]
            let paramNext = block.params[i + 1]
            let paramLine = param.location.start.line
            let paramLineNext = paramNext ? paramNext.location.start.line : -1
            if ((paramLineNext === paramLine && paramLineNext !== -1) || paramLine === paramLinePrev || paramLine === blockLine) {
              let ch = document.getText(new vscode.Range(document.positionAt(param.location.end.offset - 1), document.positionAt(param.location.end.offset)))
              if (ch !== ';')
                this.addInsert(document, param.location.end.offset, ';')
              if (paramLinePrev === -1 && paramLine !== blockLine) {
                const indent = indentWith.repeat(level);
                this.addEdit(document, param.indent.start.offset, param.indent.end.offset, indent);
              }
              else
                this.addEdit(document, param.indent.start.offset, param.indent.end.offset, ' ');
            }
            else {
              // Apply newline limiting logic here
              let newlineCount = paramLine - (paramLinePrev !== -1 ? paramLinePrev : blockLine) - 1;
              let allowedNewlines = Math.min(newlineCount, maxPreservedNewlines);

              let newIndent = '\n'.repeat(Math.max(1, allowedNewlines)) + indentWith.repeat(level);
              this.addEdit(document, param.indent.start.offset, param.indent.end.offset, newIndent);
            }

            paramLinePrev = param.location.start.line;
          }
          for (let subBlock of block.blocks) {
            formatBlock(subBlock, level + 1);
          }
        }.bind(this);

        function formatParamName(param): string {
          if (param.value[0][0] === "@")
            return `"${param.value[0]}"`;
          return param.value[0];
        }

        function formatParamValue(param): string {
          let paramValue = param.value[2];
          if (param.value[1] === "t" && paramValue[0] !== "'" && paramValue[0] !== '"')
            return `"${paramValue}"`;
          return paramValue;
        }

        function formatBlockName(block): string {
          if (block.name[0] === "@")
            return `"${block.name}"`;
          return block.name;
        }

        function removeTrailingWhitespace(str: string) {
          return str.split('\n').map(v => v.replace(/\s+$/, '')).join('\n');
        }

        let replaceBlock = function (block, level) {
          let lines = [];
          for (let param of block.params) {
            if (!lines[param.location.start.line])
              lines[param.location.start.line] = [];
            lines[param.location.start.line].push({ type: 'param', value: param });
          }
          for (let subBlock of block.blocks) {
            if (!lines[subBlock.location.start.line])
              lines[subBlock.location.start.line] = [];
            lines[subBlock.location.start.line].push({ type: 'block', value: subBlock });
          }
          for (let include of block.includes) {
            if (!lines[include.location.start.line])
              lines[include.location.start.line] = [];
            lines[include.location.start.line].push({ type: 'include', value: include });
          }
          for (let comment of block.comments) {
            if (!lines[comment.location.start.line])
              lines[comment.location.start.line] = [];
            lines[comment.location.start.line].push({ type: 'comment', value: comment });
          }
          let emptylines = block.emptylines.filter(v => v.location.start.column === 1);

          // Apply maxPreservedNewlines when determining which empty lines to remove
          // Group consecutive empty lines and keep only up to maxPreservedNewlines
          let lastLine = -1;
          let consecutiveCount = 0;
          let linesToKeep = {};

          // Sort empty lines by line number
          emptylines.sort((a, b) => a.location.start.line - b.location.start.line);

          // First pass - mark lines to keep
          for (let emptyline of emptylines) {
            const lineNum = emptyline.location.start.line;

            if (lastLine !== -1 && lineNum === lastLine + 1) {
              // Consecutive empty line
              consecutiveCount++;
              if (consecutiveCount <= maxPreservedNewlines) {
                linesToKeep[lineNum] = true;
              } else {
                emptyline._remove = true;
              }
            } else {
              // Start of a new group of empty lines
              consecutiveCount = 0;
              if (maxPreservedNewlines > 0) {
                // Only keep if we're preserving newlines
                linesToKeep[lineNum] = true;
              } else {
                emptyline._remove = true;
              }
            }

            lastLine = lineNum;
          }

          // Add the preserved empty lines to the lines array
          for (let emptyline of emptylines.filter(v => v._remove !== true)) {
            const lineNum = emptyline.location.start.line;
            if (!lines[lineNum]) {
              lines[lineNum] = [];
            }
            lines[lineNum].push({ type: 'empty line', value: emptyline });
          }

          const indent = indentWith.repeat(level);
          const isRoot = block.name === '';
          const isEmpty = block.params.length <= 0 && block.blocks.length <= 0 && block.includes.length <= 0 && block.comments.length <= 0;
          const isOneLine = !isRoot && block.blocks.length <= 0 && block.includes.length <= 0  && block.comments.length <= 0 && block.params.length > 0 && block.location.start.line === block.params[0].location.start.line;
          const isMultiLine = !isOneLine && !isEmpty;
          const prevIndent = isOneLine || isEmpty || isRoot ? '' : (indentWith.repeat(level - 1));

          const fmt = {
            param: v => `${isOneLine ? '' : indent}${formatParamName(v)}:${v.value[1]}${equalSpacing}${formatParamValue(v)}`,
            block: v => {
              // For blocks, check if we need to add newline or not based on maxPreservedNewlines
              const blockContent = replaceBlock(v, level + 1);
              return `${indent}${blockContent}`;
            },
            include: v => `${indent}include "${v.value}"`,
            comment: (v, f) => `${f ? ' ' : indent}${removeTrailingWhitespace(v.value)}`,
            'empty line': () => null
          }

          let content = [];

          if (isMultiLine && !isRoot) {
            content.push("\n");
          }

          lines = lines.filter(v => !!v)

          if (isOneLine) {
            lines = [lines.reduce((res, v) => res.concat(v), [])];
          }

          // Sort the lines by line number before processing
          const sortedLines = Object.keys(lines).sort((a, b) => parseInt(a) - parseInt(b)).map(key => lines[key]);

          for (let line of sortedLines) {
            const isEndWithComment = line.length > 1 && line[line.length - 1].type === 'comment';
            if (isOneLine) {
              content.push(blockSpacing);
            }
            const str = line.map(v => fmt[v.type](v.value, isEndWithComment)).filter(v => !!v).join(isMultiLine && !isEndWithComment ? "\n" : isOneLine ? "; " : "");
            content.push(str);
            if (isMultiLine) {
              content.push("\n");
            }
            else if (isOneLine) {
              content.push("; ");
            }
          }

          if (isRoot)
            return content.join("");

          return `${formatBlockName(block)}${blockSpacing}{${content.join("")}${prevIndent}}`;
        }.bind(this);

        let level = 0;
        const blockFormatted = replaceBlock(blkRoot, level);
        this.addEdit(document, blkRoot.location.start.offset, blkRoot.location.end.offset, blockFormatted);
      }
      catch (err) {
        console.log({error: err.message});
        let errRange = new vscode.Range(document.positionAt(err.location.start.offset), document.positionAt(err.location.end.offset));
        errors.push(new vscode.Diagnostic(errRange, `Line: ${err.location.start.line}; Message: ${err.message}`, vscode.DiagnosticSeverity.Error));
      }


      if (!this.onlyValidate && errors.length > 0 && this.edits.length > 0)
      {
        this.onlyValidate = true;
        setTimeout(() => this.provideDocumentRangeFormattingEdits(document, range, options, token), 500);
      }
      else if (this.onlyValidate)
      {
        this.onlyValidate = false;
        g_diagnostic_collection.set(document.uri, errors);
      }

      if (errors.length > 0)
        g_diagnostic_collection.set(document.uri, errors);

      return Promise.resolve(this.edits);
    }
  }
}