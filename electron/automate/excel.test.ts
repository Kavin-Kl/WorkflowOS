import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { executorsFor } from './executors'

const ctx = { runId: 'r', vars: {}, dataDir: os.tmpdir(), log: () => {} }
const append = executorsFor('excel.append_row')[0]

describe('excel.append_row', () => {
  it('appends to an existing workbook, keeping numbers numeric', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'Requests.xlsx')
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Log').addRow(['Customer', 'Seats'])
    await wb.xlsx.writeFile(file)
    await append.execute({ file, values: 'Priya Raman | 40' }, ctx)
    const back = new ExcelJS.Workbook()
    await back.xlsx.readFile(file)
    const ws = back.getWorksheet('Log')!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).values).toEqual([undefined, 'Priya Raman', 40])
  })

  it('appends to a CSV with quoting', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'log.csv')
    fs.writeFileSync(file, 'name,note')
    await append.execute({ file, values: 'Ben | said "hi", twice' }, ctx)
    expect(fs.readFileSync(file, 'utf8')).toBe('name,note\nBen,"said ""hi"", twice"\n')
  })
})
