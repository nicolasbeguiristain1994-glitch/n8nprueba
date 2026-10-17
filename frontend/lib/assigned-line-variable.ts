/** {{2}} inserts the assigned destination: a formatted number or the configured link. */
export const hasAssignedLineVariable = (message: string): boolean => /\{\{\s*2\s*\}\}/.test(message)
export const replaceAssignedLineVariable = (message: string, destination: string): string => message.replace(/\{\{\s*2\s*\}\}/g, () => destination)
