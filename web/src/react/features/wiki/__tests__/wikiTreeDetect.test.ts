import { describe, expect, it } from 'vitest'
import { isAsciiTree, splitTreeLineComment } from '../wikiTreeDetect'

const SAMPLE = `synax/
├── api/          # 后端服务层
│   ├── server.ts # Hono 应用入口
│   └── routes/   # REST 路由
└── web/          # 前端`

describe('isAsciiTree', () => {
  it('detects box-drawing directory trees', () => {
    expect(isAsciiTree(SAMPLE)).toBe(true)
  })

  it('rejects single-line inline code', () => {
    expect(isAsciiTree('npm run dev')).toBe(false)
  })

  it('rejects plain multiline prose', () => {
    expect(isAsciiTree('line one\nline two\nline three')).toBe(false)
  })
})

describe('splitTreeLineComment', () => {
  it('splits trailing hash comments', () => {
    expect(splitTreeLineComment('├── api/          # 后端服务层')).toEqual({
      structure: '├── api/',
      comment: '# 后端服务层',
    })
  })

  it('returns full line when no comment', () => {
    expect(splitTreeLineComment('synax/')).toEqual({
      structure: 'synax/',
      comment: null,
    })
  })
})
