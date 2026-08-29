import { describe, it, expect } from 'vitest'
import { parseBlocks, pollAnalysis } from './textract.js'

function word(id: string, text: string) {
  return { Id: id, BlockType: 'WORD', Text: text }
}

describe('parseBlocks', () => {
  it('pairs KEY_VALUE_SET blocks into kvs via child words', () => {
    const blocks = [
      { Id: 'p1', BlockType: 'PAGE' },
      word('w1', 'Gross'), word('w2', 'receipts'), word('w3', '1,000'),
      {
        Id: 'k1', BlockType: 'KEY_VALUE_SET', EntityTypes: ['KEY'],
        Relationships: [
          { Type: 'CHILD', Ids: ['w1', 'w2'] },
          { Type: 'VALUE', Ids: ['v1'] },
        ],
      },
      {
        Id: 'v1', BlockType: 'KEY_VALUE_SET', EntityTypes: ['VALUE'],
        Relationships: [{ Type: 'CHILD', Ids: ['w3'] }],
      },
    ]
    const out = parseBlocks(blocks)
    expect(out.kvs).toEqual([{ key: 'Gross receipts', value: '1,000' }])
    expect(out.num_pages).toBe(1)
    expect(out.num_blocks).toBe(blocks.length)
  })

  it('builds dense table rows with gaps filled by empty strings', () => {
    const blocks = [
      word('wa', 'A'), word('wb', 'B'),
      { Id: 'c11', BlockType: 'CELL', RowIndex: 1, ColumnIndex: 1, Relationships: [{ Type: 'CHILD', Ids: ['wa'] }] },
      { Id: 'c22', BlockType: 'CELL', RowIndex: 2, ColumnIndex: 2, Relationships: [{ Type: 'CHILD', Ids: ['wb'] }] },
      { Id: 't1', BlockType: 'TABLE', Page: 3, Relationships: [{ Type: 'CHILD', Ids: ['c11', 'c22'] }] },
    ]
    const out = parseBlocks(blocks)
    expect(out.tables).toEqual([
      { page: 3, rows: [['A', ''], ['', 'B']], row_count: 2, col_count: 2 },
    ])
  })
})

describe('pollAnalysis', () => {
  it('drains NextToken pages on success', async () => {
    const pages = [
      { JobStatus: 'IN_PROGRESS' },
      { JobStatus: 'SUCCEEDED', Blocks: [{ Id: '1' }], NextToken: 't2' },
      { Blocks: [{ Id: '2' }] },
    ]
    let i = 0
    const client = { send: async () => pages[i++] }
    const blocks = await pollAnalysis('job', { client: client as any, pollMs: 1 })
    expect(blocks.map(b => b.Id)).toEqual(['1', '2'])
  })

  it('THROWS on a failed job — the Python path printed a sentinel and exited 0, which callers stored as extraction data', async () => {
    const client = { send: async () => ({ JobStatus: 'FAILED', StatusMessage: 'bad pdf' }) }
    await expect(pollAnalysis('job', { client: client as any })).rejects.toThrow(/failed.*bad pdf/)
  })

  it('times out instead of polling forever', async () => {
    const client = { send: async () => ({ JobStatus: 'IN_PROGRESS' }) }
    await expect(pollAnalysis('job', { client: client as any, maxWaitMs: 5, pollMs: 1 }))
      .rejects.toThrow(/timed out/)
  })
})
