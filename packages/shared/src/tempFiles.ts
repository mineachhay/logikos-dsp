// Office and editor scratch files. Opening a workbook creates "~$Book.xlsx"
// (the owner/lock file) and deletes it on close; Word saves through
// "~WRL0001.tmp". On the first real share they were two thirds of all file
// events — true records, but noise to anyone reading the timeline, so pages
// hide them unless asked. Kept in sync with TEMP_FILE_WHERE in the backend,
// which says the same thing to Postgres.

export function isTemporaryFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.startsWith("~") || /\.tmp$/i.test(name);
}
