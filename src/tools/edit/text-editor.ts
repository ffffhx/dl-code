import fs from 'fs';
import path from 'path';

export type TextEditorCommand = 'view' | 'create' | 'str_replace' | 'insert';

export class TextEditor {
  validatePath(_command: TextEditorCommand, filePath: string): void {
    if (!path.isAbsolute(filePath)) {
      const suggestedPath = path.resolve(filePath);
      throw new Error(
        `The path ${filePath} is not an absolute path, it should start with \`/\`. Do you mean ${suggestedPath}?`
      );
    }
  }

  view(filePath: string, viewRange?: [number, number]): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    const fileContent = this.readFile(filePath);
    let initLine = 1;

    if (viewRange) {
      if (viewRange.length !== 2) {
        throw new Error('Invalid `view_range`. It should be a list of two integers.');
      }

      const fileLines = fileContent.split('\n');
      const nLinesFile = fileLines.length;
      const startLine = viewRange[0];
      let endLine = viewRange[1];

      if (startLine < 1 || startLine > nLinesFile) {
        throw new Error(
          `Invalid \`view_range\`: [${viewRange}]. The start line \`${startLine}\` should be within the range of lines in the file: [1, ${nLinesFile}]`
        );
      }

      if (endLine !== -1 && (endLine < startLine || endLine > nLinesFile)) {
        if (endLine > nLinesFile) {
          endLine = nLinesFile;
        } else {
          throw new Error(
            `Invalid \`view_range\`: [${viewRange}]. The end line \`${endLine}\` should be -1 or within the range of lines in the file: [${startLine}, ${nLinesFile}]`
          );
        }
      }

      const slicedLines =
        endLine === -1
          ? fileLines.slice(startLine - 1)
          : fileLines.slice(startLine - 1, endLine);

      initLine = startLine;
      return this.contentWithLineNumbers(slicedLines.join('\n'), initLine);
    }

    return this.contentWithLineNumbers(fileContent, initLine);
  }

  strReplace(filePath: string, oldStr: string, newStr: string): number {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    const fileContent = this.readFile(filePath);

    if (!fileContent.includes(oldStr)) {
      throw new Error(`String not found in file: ${filePath}`);
    }

    const newContent = fileContent.replace(new RegExp(this.escapeRegex(oldStr), 'g'), newStr);
    const occurrences = (fileContent.match(new RegExp(this.escapeRegex(oldStr), 'g')) || []).length;

    this.writeFile(filePath, newContent);

    return occurrences;
  }

  insert(filePath: string, insertLine: number, newStr: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    const fileContent = this.readFile(filePath);
    const lines = fileContent.split('\n');

    if (insertLine < 0) {
      throw new Error(`Invalid insert_line: ${insertLine}. Line number must be >= 0.`);
    }

    if (insertLine > lines.length) {
      throw new Error(
        `Invalid insert_line: ${insertLine}. Line number cannot be greater than the number of lines in the file (${lines.length}).`
      );
    }

    if (insertLine === 0) {
      lines.unshift(newStr);
    } else {
      lines.splice(insertLine, 0, newStr);
    }

    const newContent = lines.join('\n');
    this.writeFile(filePath, newContent);
  }

  readFile(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new Error(`Error reading ${filePath}: ${error}`);
    }
  }

  writeFile(filePath: string, content: string): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
      throw new Error(`Error writing to ${filePath}: ${error}`);
    }
  }

  private contentWithLineNumbers(fileContent: string, initLine: number = 1): string {
    const lines = fileContent.split('\n');
    const numberedLines = lines.map((line, i) => {
      const lineNum = (i + initLine).toString().padStart(3, ' ');
      return `${lineNum} ${line}`;
    });
    return numberedLines.join('\n');
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
