/** {{2}} is the formatted assigned number in an Ofizeus reply automation. */
export const hasAssignedLineVariable = (message: string): boolean => /\{\{\s*2\s*\}\}/.test(message)
export const replaceAssignedLineVariable = (message: string, number: string): string => message.replace(/\{\{\s*2\s*\}\}/g, () => number)
