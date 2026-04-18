'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { LayoutDashboard, CheckSquare, StickyNote, Briefcase, Users, Calendar, Lightbulb, Plus, Trash2, Check, Pin, Search, X, Building2, Settings } from 'lucide-react'

const NAV_ITEMS = [
  { value: 'dashboard', label: 'ダッシュボード', icon: LayoutDashboard, color: 'text-[#0071e3]' },
  { value: 'owner', label: 'オーナー設定', icon: Settings, color: 'text-[#0071e3]' },
  { value: 'task', label: 'タスク', icon: CheckSquare, color: 'text-[#34c759]' },
  { value: 'memo', label: 'メモ', icon: StickyNote, color: 'text-[#ff9f0a]' },
  { value: 'business_master', label: '事業マスタ', icon: Building2, color: 'text-[#0071e3]' },
  { value: 'business', label: 'ビジネス案', icon: Briefcase, color: 'text-[#7c5cbf]' },
  { value: 'people', label: '人物DB', icon: Users, color: 'text-[#ff3b30]' },
  { value: 'calendar', label: 'カレンダー', icon: Calendar, color: 'text-[#34c759]' },
  { value: 'ideas', label: 'アイデア倉庫', icon: Lightbulb, color: 'text-[#ff9f0a]' },
]

const PAGE_TITLES: Record<string, string> = {
  dashboard: 'ダッシュボード', owner: 'オーナー設定', task: 'タスク', memo: 'メモ',
  business_master: '事業マスタ', business: 'ビジネス案', people: '人物DB',
  calendar: 'カレンダー', ideas: 'アイデア倉庫',
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  '構想中': { bg: 'bg-[#fff4e0]', text: 'text-[#8a5800]', dot: 'bg-[#ff9f0a]' },
  '進行中': { bg: 'bg-[#e8f8ed]', text: 'text-[#1a7a35]', dot: 'bg-[#34c759]' },
  '完了': { bg: 'bg-[#f0edf8]', text: 'text-[#5e3fa3]', dot: 'bg-[#7c5cbf]' },
  '保留': { bg: 'bg-[#f5f5f7]', text: 'text-[#6e6e73]', dot: 'bg-[#aeaeb2]' },
}

const MEMO_COLORS = {
  yellow: { bg: 'bg-[#fff9c4]', border: 'border-[#f9e94e]' },
  blue: { bg: 'bg-[#e3f2fd]', border: 'border-[#90caf9]' },
  green: { bg: 'bg-[#e8f5e9]', border: 'border-[#a5d6a7]' },
  pink: { bg: 'bg-[#fce4ec]', border: 'border-[#f48fb1]' },
  white: { bg: 'bg-white', border: 'border-[#e8e8ed]' },
}

function parseEventTitle(title: string) {
  const dateMatch = title.match(/\d{4}-\d{2}-\d{2}/)
  const timeMatch = title.match(/\d{2}:\d{2}/)
  const label = title.replace(/\d{4}-\d{2}-\d{2}\s*/, '').replace(/\d{2}:\d{2}\s*/, '').trim()
  return { date: dateMatch?.[0], time: timeMatch?.[0], label }
}

function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 p-6 z-10 max-h-[90vh] overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

function OwnerMasterView({ items, onRefresh }: { items: any[], onRefresh: () => void }) {
  const [form, setForm] = useState({
    name: '',
    company: '',
    position: '',
    thinking_pattern: '',
    priority_style: '',
    writing_style: '',
    active_tasks: '',
    key_issues: '',
  })
  const [saved, setSaved] = useState(false)
  const [ownerId, setOwnerId] = useState<string | null>(null)

  useEffect(() => {
    if (items && items.length > 0) {
      const o = items[0]
      setOwnerId(o.id)
      setForm({
        name: o.name || '',
        company: o.company || '',
        position: o.position || '',
        thinking_pattern: o.thinking_pattern || '',
        priority_style: o.priority_style || '',
        writing_style: o.writing_style || '',
        active_tasks: o.active_tasks || '',
        key_issues: o.key_issues || '',
      })
    }
  }, [items])

  const save = async () => {
    if (ownerId) {
      await supabase.from('owner_master').update({ ...form, updated_at: new Date().toISOString() }).eq('id', ownerId)
    } else {
      await supabase.from('owner_master').insert(form)
    }
    onRefresh()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const fields = [
    { key: 'name', label: '名前', placeholder: '山田 太郎', multiline: false },
    { key: 'company', label: '会社名', placeholder: '株式会社〇〇', multiline: false },
    { key: 'position', label: '役職', placeholder: '代表取締役', multiline: false },
    { key: 'thinking_pattern', label: '思考パターン', placeholder: '例：直感型・決断が速い・大局を見る', multiline: true },
    { key: 'priority_style', label: '優先順位の傾向', placeholder: '例：売上直結・スピード優先・関係重視', multiline: true },
    { key: 'writing_style', label: '文体・口調', placeholder: '例：簡潔・断定的・敬語なし', multiline: true },
    { key: 'active_tasks', label: '今の最重要タスク', placeholder: '例：新規事業の立ち上げ・採用強化', multiline: true },
    { key: 'key_issues', label: '進行中の重要案件', placeholder: '例：A社との契約交渉・新サービス開発', multiline: true },
  ]

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-[#e8f1fd] rounded-2xl p-4 border border-[#90caf9]">
        <p className="text-[13px] text-[#0056b3]">ここに入力した情報はNOIDAの判断基準になります。詳しく書くほどNOIDAの精度が上がります。</p>
      </div>
      <div className="bg-white rounded-2xl border border-[#e8e8ed] p-6 shadow-sm space-y-5">
        {fields.map(field => (
          <div key={field.key}>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2] mb-1.5 block">{field.label}</label>
            {field.multiline ? (
              <textarea value={(form as any)[field.key]} onChange={e => setForm(p => ({ ...p, [field.key]: e.target.value }))}
                placeholder={field.placeholder} rows={3}
                className="w-full text-[13px] outline-none resize-none text-[#1d1d1f] placeholder:text-[#aeaeb2] leading-relaxed border border-[#e8e8ed] rounded-xl p-3 focus:border-[#0071e3] transition-colors" />
            ) : (
              <input value={(form as any)[field.key]} onChange={e => setForm(p => ({ ...p, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                className="w-full text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border border-[#e8e8ed] rounded-xl px-3 py-2.5 focus:border-[#0071e3] transition-colors" />
            )}
          </div>
        ))}
        <div className="pt-2 flex items-center justify-between">
          {saved && <span className="text-[12px] text-[#34c759]">保存しました ✓</span>}
          <div className="ml-auto">
            <button onClick={save} className="bg-[#0071e3] text-white rounded-xl px-6 py-2.5 text-[13px] font-medium hover:bg-[#0051d5] transition-colors">保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskView({ items, onRefresh }: { items: any[], onRefresh: () => void }) {
  const [input, setInput] = useState('')
  const add = async () => {
    if (!input.trim()) return
    await supabase.from('task').insert({ content: input.trim(), done: false })
    setInput(''); onRefresh()
  }
  const toggle = async (id: string, done: boolean) => {
    await supabase.from('task').update({ done: !done }).eq('id', id); onRefresh()
  }
  const del = async (id: string) => {
    await supabase.from('task').delete().eq('id', id); onRefresh()
  }
  const pending = items.filter(t => !t.done)
  const done = items.filter(t => t.done)
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-[#e8e8ed] p-4 flex gap-2 shadow-sm">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
          placeholder="新しいタスクを追加... (Enter)" className="flex-1 text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2]" />
        <button onClick={add} className="w-8 h-8 bg-[#34c759] rounded-lg flex items-center justify-center">
          <Plus className="w-4 h-4 text-white" />
        </button>
      </div>
      {pending.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#e8e8ed] overflow-hidden shadow-sm">
          <div className="px-5 py-3 border-b border-[#f5f5f7]">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[#aeaeb2]">未完了 {pending.length}</p>
          </div>
          {pending.map((item: any) => (
            <div key={item.id} className="flex items-center gap-3 px-5 py-3.5 border-b border-[#f5f5f7] last:border-0 hover:bg-[#f9f9fb] group transition-colors">
              <button onClick={() => toggle(item.id, item.done)} className="w-5 h-5 rounded-full border-2 border-[#d1d1d6] hover:border-[#34c759] flex items-center justify-center flex-shrink-0 transition-colors" />
              <p className="flex-1 text-[13px] text-[#1d1d1f]">{item.content}</p>
              <button onClick={() => del(item.id)} className="opacity-0 group-hover:opacity-100 transition-opacity p-1">
                <Trash2 className="w-3.5 h-3.5 text-[#ff3b30]" />
              </button>
            </div>
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#e8e8ed] overflow-hidden shadow-sm opacity-60">
          <div className="px-5 py-3 border-b border-[#f5f5f7]">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[#aeaeb2]">完了 {done.length}</p>
          </div>
          {done.map((item: any) => (
            <div key={item.id} className="flex items-center gap-3 px-5 py-3.5 border-b border-[#f5f5f7] last:border-0 hover:bg-[#f9f9fb] group transition-colors">
              <button onClick={() => toggle(item.id, item.done)} className="w-5 h-5 rounded-full border-2 border-[#34c759] bg-[#34c759] flex items-center justify-center flex-shrink-0">
                <Check className="w-3 h-3 text-white" />
              </button>
              <p className="flex-1 text-[13px] text-[#aeaeb2] line-through">{item.content}</p>
              <button onClick={() => del(item.id)} className="opacity-0 group-hover:opacity-100 transition-opacity p-1">
                <Trash2 className="w-3.5 h-3.5 text-[#ff3b30]" />
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length === 0 && (
        <div className="bg-white rounded-2xl border border-[#e8e8ed] p-12 text-center shadow-sm">
          <CheckSquare className="w-10 h-10 text-[#d2d2d7] mx-auto mb-3" />
          <p className="text-[13px] text-[#aeaeb2]">タスクはありません</p>
        </div>
      )}
    </div>
  )
}

function MemoView({ items, onRefresh }: { items: any[], onRefresh: () => void }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form, setForm] = useState({ title: '', content: '', color: 'yellow', pinned: false })
  const [search, setSearch] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openNew = async () => {
    const { data } = await supabase.from('memo').insert({ content: '', title: '', color: 'yellow', pinned: false }).select().single()
    if (data) { setEditing(data); setForm({ title: '', content: '', color: 'yellow', pinned: false }); setModalOpen(true); onRefresh() }
  }
  const openEdit = (item: any) => {
    setEditing(item); setForm({ title: item.title || '', content: item.content || '', color: item.color || 'yellow', pinned: item.pinned || false }); setModalOpen(true)
  }
  const save = async () => {
    if (!editing) return
    await supabase.from('memo').update({ ...form, updated_at: new Date().toISOString() }).eq('id', editing.id)
    onRefresh(); setModalOpen(false)
  }
  const del = async (id: string) => {
    await supabase.from('memo').delete().eq('id', id); onRefresh(); setModalOpen(false)
  }
  const togglePin = async (id: string, pinned: boolean) => {
    await supabase.from('memo').update({ pinned: !pinned }).eq('id', id); onRefresh()
  }

  useEffect(() => {
    if (!editing || !modalOpen) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      await supabase.from('memo').update({ ...form, updated_at: new Date().toISOString() }).eq('id', editing.id)
      onRefresh(); setSaveStatus('saved'); setTimeout(() => setSaveStatus('idle'), 2000)
    }, 800)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [form])

  const filtered = items.filter(m => !search || m.content?.includes(search) || m.title?.includes(search))
  const pinned = filtered.filter(m => m.pinned)
  const rest = filtered.filter(m => !m.pinned)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 bg-white border border-[#e8e8ed] rounded-2xl px-4 py-3 flex-1 mr-3 shadow-sm">
          <Search className="w-4 h-4 text-[#aeaeb2] flex-shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="メモを検索..."
            className="flex-1 text-[13px] outline-none placeholder:text-[#aeaeb2] text-[#1d1d1f]" />
          {search && <button onClick={() => setSearch('')}><X className="w-4 h-4 text-[#aeaeb2]" /></button>}
        </div>
        <button onClick={openNew} className="bg-[#0071e3] text-white rounded-xl px-4 py-3 text-[13px] font-medium hover:bg-[#0051d5] transition-colors flex items-center gap-2 shadow-sm flex-shrink-0">
          <Plus className="w-4 h-4" /> 新規メモ
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="py-16 flex flex-col items-center gap-3">
          <StickyNote className="w-10 h-10 text-[#d2d2d7]" />
          <p className="text-[13px] text-[#aeaeb2]">メモはありません</p>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-[#aeaeb2] mb-3">ピン留め</p>
              <div className="grid grid-cols-3 gap-4">
                {pinned.map((item: any) => <MemoCard key={item.id} item={item} onEdit={() => openEdit(item)} onDelete={() => del(item.id)} onPin={() => togglePin(item.id, item.pinned)} />)}
              </div>
            </div>
          )}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[#aeaeb2] mb-3">すべてのメモ</p>
            <div className="grid grid-cols-3 gap-4">
              {rest.map((item: any) => <MemoCard key={item.id} item={item} onEdit={() => openEdit(item)} onDelete={() => del(item.id)} onPin={() => togglePin(item.id, item.pinned)} />)}
            </div>
          </div>
        </>
      )}
      <Modal open={modalOpen} onClose={save}>
        <div className="space-y-4">
          <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
            placeholder="タイトルを入力" className="w-full text-[18px] font-bold outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2]" />
          <div className="border-t border-[#f5f5f7]" />
          <textarea value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
            placeholder="内容を入力" rows={8} className="w-full text-[14px] outline-none resize-none text-[#1d1d1f] placeholder:text-[#aeaeb2] leading-relaxed" />
          <div className="border-t border-[#f5f5f7] pt-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                {Object.entries(MEMO_COLORS).map(([key, val]) => (
                  <button key={key} onClick={() => setForm(p => ({ ...p, color: key }))}
                    className={`w-5 h-5 rounded-full ${val.bg} border-2 ${val.border} ${form.color === key ? 'ring-2 ring-offset-1 ring-[#0071e3]' : ''}`} />
                ))}
              </div>
              <button onClick={() => setForm(p => ({ ...p, pinned: !p.pinned }))} className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[#f5f5f7]">
                <Pin className={`w-4 h-4 ${form.pinned ? 'text-[#ff9f0a] fill-[#ff9f0a]' : 'text-[#aeaeb2]'}`} />
                <span className="text-[12px] text-[#6e6e73]">ピン留め</span>
              </button>
              <button onClick={() => editing && del(editing.id)} className="p-1.5 rounded-lg hover:bg-[#fde8ec]">
                <Trash2 className="w-4 h-4 text-[#ff3b30]" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              {saveStatus === 'saved' && <span className="text-[12px] text-[#34c759]">自動保存済み</span>}
              <button onClick={save} className="bg-[#0071e3] text-white rounded-xl px-5 py-2 text-[13px] font-medium">保存</button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function MemoCard({ item, onEdit, onDelete, onPin }: any) {
  const colors = MEMO_COLORS[item.color as keyof typeof MEMO_COLORS] || MEMO_COLORS.white
  return (
    <div onClick={onEdit} className={`${colors.bg} ${colors.border} border rounded-2xl p-5 cursor-pointer group shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200`}>
      <div className="space-y-2">
        {item.title && <h3 className="text-[14px] font-semibold text-[#1d1d1f]">{item.title}</h3>}
        <p className="text-[13px] text-[#6e6e73] leading-relaxed line-clamp-5">{item.content}</p>
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-black/5">
        <span className="text-[10px] text-[#aeaeb2]">{new Date(item.created_at).toLocaleDateString('ja-JP')}</span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={e => { e.stopPropagation(); onPin() }} className="p-1 rounded hover:bg-black/5">
            <Pin className={`w-3.5 h-3.5 ${item.pinned ? 'text-[#ff9f0a] fill-[#ff9f0a]' : 'text-[#aeaeb2]'}`} />
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete() }} className="p-1 rounded hover:bg-black/5">
            <Trash2 className="w-3.5 h-3.5 text-[#aeaeb2] hover:text-[#ff3b30]" />
          </button>
        </div>
      </div>
    </div>
  )
}

function BusinessMasterView({ items, onRefresh }: { items: any[], onRefresh: () => void }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form, setForm] = useState({ name: '', summary: '', status: '構想中', note: '' })

  const openNew = () => { setEditing(null); setForm({ name: '', summary: '', status: '構想中', note: '' }); setModalOpen(true) }
  const openEdit = (item: any) => {
    setEditing(item)
    setForm({ name: item.name || '', summary: item.summary || '', status: item.status || '構想中', note: item.note || '' })
    setModalOpen(true)
  }
  const save = async () => {
    if (!form.name.trim()) return
    if (editing) {
      await supabase.from('business_master').update({ ...form, updated_at: new Date().toISOString() }).eq('id', editing.id)
    } else {
      await supabase.from('business_master').insert(form)
    }
    onRefresh(); setModalOpen(false)
  }
  const del = async (id: string) => {
    await supabase.from('business_master').delete().eq('id', id); onRefresh(); setModalOpen(false)
  }
  const statusColors = (status: string) => STATUS_COLORS[status] || STATUS_COLORS['構想中']

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={openNew} className="bg-[#0071e3] text-white rounded-xl px-4 py-3 text-[13px] font-medium flex items-center gap-2 shadow-sm">
          <Plus className="w-4 h-4" /> 事業を追加
        </button>
      </div>
      {items.length === 0 ? (
        <div className="py-16 flex flex-col items-center gap-3">
          <Building2 className="w-10 h-10 text-[#d2d2d7]" />
          <p className="text-[13px] text-[#aeaeb2]">事業データはありません</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {items.map((item: any) => {
            const sc = statusColors(item.status)
            return (
              <div key={item.id} onClick={() => openEdit(item)}
                className="bg-white border border-[#e8e8ed] rounded-2xl p-5 cursor-pointer group shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                <div className="flex items-start justify-between mb-3">
                  <h3 className="text-[15px] font-bold text-[#1d1d1f]">{item.name}</h3>
                  <span className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium ${sc.bg} ${sc.text}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                    {item.status}
                  </span>
                </div>
                {item.summary && <p className="text-[12px] text-[#6e6e73] mb-3">{item.summary}</p>}
                {item.note && (
                  <div className="border-t border-[#f5f5f7] pt-3 mt-3">
                    <p className="text-[12px] text-[#1d1d1f] leading-relaxed line-clamp-4 whitespace-pre-wrap">{item.note}</p>
                  </div>
                )}
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#f5f5f7]">
                  <span className="text-[10px] text-[#aeaeb2]">{new Date(item.updated_at || item.created_at).toLocaleDateString('ja-JP')}</span>
                  <button onClick={e => { e.stopPropagation(); del(item.id) }} className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-black/5">
                    <Trash2 className="w-3.5 h-3.5 text-[#aeaeb2] hover:text-[#ff3b30]" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <div className="space-y-4">
          <h3 className="text-[16px] font-bold text-[#1d1d1f]">{editing ? '事業を編集' : '事業を追加'}</h3>
          <div className="border-t border-[#f5f5f7]" />
          <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="事業名 *" className="w-full text-[16px] font-semibold outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border-b border-[#f5f5f7] pb-2" />
          <input value={form.summary} onChange={e => setForm(p => ({ ...p, summary: e.target.value }))}
            placeholder="概要（一行）" className="w-full text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border border-[#e8e8ed] rounded-xl px-3 py-2" />
          <div>
            <p className="text-[11px] text-[#aeaeb2] mb-2">ステータス</p>
            <div className="flex gap-2">
              {['構想中', '進行中', '完了', '保留'].map(s => {
                const sc = statusColors(s)
                return (
                  <button key={s} onClick={() => setForm(p => ({ ...p, status: s }))}
                    className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors flex items-center gap-1.5 ${form.status === s ? `${sc.bg} ${sc.text}` : 'bg-[#f5f5f7] text-[#6e6e73]'}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${form.status === s ? sc.dot : 'bg-[#aeaeb2]'}`} />
                    {s}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-[#aeaeb2] mb-2">詳細・アイデア・メモ（追記式）</p>
            <textarea value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))}
              placeholder="A案：...\nB案：...\n進捗：..." rows={8}
              className="w-full text-[13px] outline-none resize-none text-[#1d1d1f] placeholder:text-[#aeaeb2] leading-relaxed border border-[#e8e8ed] rounded-xl p-3" />
          </div>
          <div className="border-t border-[#f5f5f7] pt-4 flex items-center justify-between">
            <div>
              {editing && (
                <button onClick={() => del(editing.id)} className="p-1.5 rounded-lg hover:bg-[#fde8ec]">
                  <Trash2 className="w-4 h-4 text-[#ff3b30]" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded-xl text-[13px] text-[#6e6e73] hover:bg-[#f5f5f7]">キャンセル</button>
              <button onClick={save} className="bg-[#0071e3] text-white rounded-xl px-5 py-2 text-[13px] font-medium">保存</button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CardView({ items, onRefresh, table, color, placeholder, emptyText, icon: Icon }: any) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [content, setContent] = useState('')
  const [newInput, setNewInput] = useState('')

  const add = async () => {
    if (!newInput.trim()) return
    await supabase.from(table).insert({ content: newInput.trim() })
    setNewInput(''); onRefresh()
  }
  const openEdit = (item: any) => { setEditing(item); setContent(item.content); setModalOpen(true) }
  const save = async () => {
    if (!editing) return
    await supabase.from(table).update({ content }).eq('id', editing.id)
    onRefresh(); setModalOpen(false)
  }
  const del = async (id: string) => {
    await supabase.from(table).delete().eq('id', id); onRefresh(); setModalOpen(false)
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-[#e8e8ed] p-4 flex gap-2 shadow-sm">
        <input value={newInput} onChange={e => setNewInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
          placeholder={placeholder} className="flex-1 text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2]" />
        <button onClick={add} className={`w-8 h-8 ${color} rounded-lg flex items-center justify-center`}>
          <Plus className="w-4 h-4 text-white" />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="py-16 flex flex-col items-center gap-3">
          <Icon className="w-10 h-10 text-[#d2d2d7]" />
          <p className="text-[13px] text-[#aeaeb2]">{emptyText}</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {items.map((item: any) => (
            <div key={item.id} onClick={() => openEdit(item)}
              className="bg-white border border-[#e8e8ed] rounded-2xl p-5 cursor-pointer group shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
              <p className="text-[13px] text-[#1d1d1f] leading-relaxed line-clamp-5">{item.content}</p>
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#f5f5f7]">
                <span className="text-[10px] text-[#aeaeb2]">{new Date(item.created_at).toLocaleDateString('ja-JP')}</span>
                <button onClick={e => { e.stopPropagation(); del(item.id) }} className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-black/5">
                  <Trash2 className="w-3.5 h-3.5 text-[#aeaeb2] hover:text-[#ff3b30]" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={modalOpen} onClose={save}>
        <div className="space-y-4">
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="内容を編集..." rows={8}
            className="w-full text-[14px] outline-none resize-none text-[#1d1d1f] placeholder:text-[#aeaeb2] leading-relaxed" />
          <div className="border-t border-[#f5f5f7] pt-4 flex items-center justify-between">
            <button onClick={() => editing && del(editing.id)} className="p-1.5 rounded-lg hover:bg-[#fde8ec]">
              <Trash2 className="w-4 h-4 text-[#ff3b30]" />
            </button>
            <button onClick={save} className={`${color} text-white rounded-xl px-5 py-2 text-[13px] font-medium`}>保存</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function PeopleView({ items, onRefresh }: { items: any[], onRefresh: () => void }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form, setForm] = useState({ name: '', company: '', position: '', note: '', importance: 'B' })

  const openNew = () => { setEditing(null); setForm({ name: '', company: '', position: '', note: '', importance: 'B' }); setModalOpen(true) }
  const openEdit = (item: any) => {
    setEditing(item)
    setForm({ name: item.name || '', company: item.company || '', position: item.position || '', note: item.note || '', importance: item.importance || 'B' })
    setModalOpen(true)
  }
  const save = async () => {
    if (!form.name.trim()) return
    if (editing) {
      await supabase.from('people').update(form).eq('id', editing.id)
    } else {
      await supabase.from('people').insert(form)
    }
    onRefresh(); setModalOpen(false)
  }
  const del = async (id: string) => {
    await supabase.from('people').delete().eq('id', id); onRefresh(); setModalOpen(false)
  }

  const importanceColors: Record<string, string> = {
    'S': 'bg-[#ff3b30] text-white',
    'A': 'bg-[#ff9f0a] text-white',
    'B': 'bg-[#34c759] text-white',
    'C': 'bg-[#aeaeb2] text-white',
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={openNew} className="bg-[#ff3b30] text-white rounded-xl px-4 py-3 text-[13px] font-medium flex items-center gap-2 shadow-sm">
          <Plus className="w-4 h-4" /> 人物を追加
        </button>
      </div>
      {items.length === 0 ? (
        <div className="py-16 flex flex-col items-center gap-3">
          <Users className="w-10 h-10 text-[#d2d2d7]" />
          <p className="text-[13px] text-[#aeaeb2]">人物データはありません</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {items.map((item: any) => (
            <div key={item.id} onClick={() => openEdit(item)}
              className="bg-white border border-[#e8e8ed] rounded-2xl p-5 cursor-pointer group shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-[#ff3b30]/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-[16px] font-bold text-[#ff3b30]">{item.name?.[0]}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[14px] font-semibold text-[#1d1d1f] truncate">{item.name}</p>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${importanceColors[item.importance] || importanceColors['B']}`}>
                      {item.importance}
                    </span>
                  </div>
                  {(item.company || item.position) && (
                    <p className="text-[11px] text-[#aeaeb2] truncate">{[item.position, item.company].filter(Boolean).join(' · ')}</p>
                  )}
                </div>
              </div>
              {item.note && <p className="text-[12px] text-[#6e6e73] leading-relaxed line-clamp-3">{item.note}</p>}
            </div>
          ))}
        </div>
      )}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <div className="space-y-4">
          <h3 className="text-[16px] font-bold text-[#1d1d1f]">{editing ? '人物を編集' : '人物を追加'}</h3>
          <div className="border-t border-[#f5f5f7]" />
          <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="名前 *" className="w-full text-[16px] font-semibold outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border-b border-[#f5f5f7] pb-2" />
          <div className="grid grid-cols-2 gap-3">
            <input value={form.company} onChange={e => setForm(p => ({ ...p, company: e.target.value }))}
              placeholder="会社名" className="text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border border-[#e8e8ed] rounded-xl px-3 py-2" />
            <input value={form.position} onChange={e => setForm(p => ({ ...p, position: e.target.value }))}
              placeholder="役職" className="text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border border-[#e8e8ed] rounded-xl px-3 py-2" />
          </div>
          <div>
            <p className="text-[11px] text-[#aeaeb2] mb-2">重要度</p>
            <div className="flex gap-2">
              {['S', 'A', 'B', 'C'].map(n => (
                <button key={n} onClick={() => setForm(p => ({ ...p, importance: n }))}
                  className={`px-4 py-2 rounded-lg text-[12px] font-bold transition-colors ${form.importance === n ? importanceColors[n] : 'bg-[#f5f5f7] text-[#6e6e73]'}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <textarea value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))}
            placeholder="特記事項・メモ" rows={4}
            className="w-full text-[14px] outline-none resize-none text-[#1d1d1f] placeholder:text-[#aeaeb2] leading-relaxed border border-[#e8e8ed] rounded-xl p-3" />
          <div className="border-t border-[#f5f5f7] pt-4 flex items-center justify-between">
            <div>
              {editing && (
                <button onClick={() => del(editing.id)} className="p-1.5 rounded-lg hover:bg-[#fde8ec]">
                  <Trash2 className="w-4 h-4 text-[#ff3b30]" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded-xl text-[13px] text-[#6e6e73] hover:bg-[#f5f5f7]">キャンセル</button>
              <button onClick={save} className="bg-[#ff3b30] text-white rounded-xl px-5 py-2 text-[13px] font-medium">保存</button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CalendarView({ items, onRefresh }: { items: any[], onRefresh: () => void }) {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const today = new Date()
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const getEventsForDay = (day: number) => items.filter(item => {
    const { date } = parseEventTitle(item.title)
    if (!date) return false
    const d = new Date(date)
    return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day
  })

  const add = async () => {
    if (!input.trim() || !selectedDay) return
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`
    await supabase.from('calendar').insert({ title: `${dateStr} ${input.trim()}`, datetime: new Date(`${dateStr}T00:00:00`) })
    setInput(''); onRefresh()
  }
  const del = async (id: string) => {
    await supabase.from('calendar').delete().eq('id', id); onRefresh()
  }

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let i = 1; i <= daysInMonth; i++) cells.push(i)

  const selectedEvents = selectedDay ? getEventsForDay(selectedDay) : []
  const todayEvents = getEventsForDay(today.getDate())

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-[#e8e8ed] overflow-hidden shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#f5f5f7]">
          <button onClick={() => setCurrentDate(new Date(year, month - 1, 1))} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#f5f5f7] text-[#6e6e73] text-lg">‹</button>
          <h3 className="text-[15px] font-bold text-[#1d1d1f]">{year}年{month + 1}月</h3>
          <button onClick={() => setCurrentDate(new Date(year, month + 1, 1))} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#f5f5f7] text-[#6e6e73] text-lg">›</button>
        </div>
        <div className="grid grid-cols-7 border-b border-[#f5f5f7]">
          {['日', '月', '火', '水', '木', '金', '土'].map(w => (
            <div key={w} className="text-center text-[11px] font-semibold text-[#aeaeb2] py-2">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear()
            const isSelected = day === selectedDay
            const events = day ? getEventsForDay(day) : []
            return (
              <div key={i} onClick={() => day && setSelectedDay(day === selectedDay ? null : day)}
                className={`min-h-[72px] p-2 border-t border-r border-[#f5f5f7] cursor-pointer transition-colors ${day ? 'hover:bg-[#f9f9fb]' : ''} ${isSelected ? 'bg-[#f0f6ff]' : ''}`}>
                {day && (
                  <>
                    <div className={`w-7 h-7 flex items-center justify-center rounded-full text-[13px] font-medium mb-1 ${isToday ? 'bg-[#0071e3] text-white' : 'text-[#1d1d1f]'}`}>{day}</div>
                    <div className="space-y-0.5">
                      {events.slice(0, 2).map((e, j) => {
                        const { time, label } = parseEventTitle(e.title)
                        return (
                          <div key={j} className="flex items-center gap-1 bg-[#e8f1fd] rounded px-1 py-0.5">
                            {time && <span className="text-[9px] font-bold text-[#0071e3] flex-shrink-0">{time}</span>}
                            <span className="text-[10px] text-[#0056b3] truncate">{label}</span>
                          </div>
                        )
                      })}
                      {events.length > 2 && <div className="text-[9px] text-[#aeaeb2] pl-1">+{events.length - 2}</div>}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {selectedDay && (
        <div className="bg-white rounded-2xl border border-[#e8e8ed] p-5 shadow-sm">
          <h3 className="text-[14px] font-bold text-[#1d1d1f] mb-4">{month + 1}月{selectedDay}日</h3>
          <div className="flex gap-2 mb-4">
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
              placeholder="予定を追加... (Enter)" className="flex-1 text-[13px] outline-none text-[#1d1d1f] placeholder:text-[#aeaeb2] border border-[#e8e8ed] rounded-xl px-3 py-2" />
            <button onClick={add} className="w-8 h-8 bg-[#34c759] rounded-lg flex items-center justify-center flex-shrink-0">
              <Plus className="w-4 h-4 text-white" />
            </button>
          </div>
          {selectedEvents.length === 0 ? <p className="text-[13px] text-[#aeaeb2]">予定はありません</p> : (
            <div className="space-y-2">
              {selectedEvents.map((e: any) => {
                const { time, label } = parseEventTitle(e.title)
                return (
                  <div key={e.id} className="flex items-center gap-3 py-2 border-b border-[#f5f5f7] last:border-0 group">
                    <div className="w-2 h-2 rounded-full bg-[#0071e3] flex-shrink-0" />
                    <div className="flex-1">
                      {time && <p className="text-[11px] font-bold text-[#0071e3]">{time}</p>}
                      <p className="text-[13px] text-[#1d1d1f]">{label}</p>
                    </div>
                    <button onClick={() => del(e.id)} className="opacity-0 group-hover:opacity-100 p-1">
                      <Trash2 className="w-3.5 h-3.5 text-[#ff3b30]" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {todayEvents.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#e8e8ed] p-5 shadow-sm">
          <h3 className="text-[14px] font-bold text-[#1d1d1f] mb-4">今日の予定</h3>
          <div className="space-y-2">
            {todayEvents.map((e: any) => {
              const { time, label } = parseEventTitle(e.title)
              return (
                <div key={e.id} className="flex items-center gap-3 py-2 border-b border-[#f5f5f7] last:border-0">
                  <div className="w-2 h-2 rounded-full bg-[#0071e3] flex-shrink-0" />
                  <div>
                    {time && <p className="text-[11px] font-bold text-[#0071e3]">{time}</p>}
                    <p className="text-[13px] text-[#1d1d1f]">{label}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function DashboardHome({ data }: { data: any }) {
  const pendingTasks = data.task?.filter((t: any) => !t.done) || []
  const recentMemos = data.memo?.slice(0, 3) || []
  const upcomingEvents = data.calendar?.slice(0, 3) || []
  const businesses = data.business_master?.slice(0, 4) || []
  const owner = data.owner_master?.[0]

  return (
    <div className="space-y-6">
      {owner?.name && (
        <div className="bg-[#1d1d1f] rounded-2xl p-5 text-white">
          <p className="text-[11px] text-[#aeaeb2] mb-1">オーナー</p>
          <p className="text-[18px] font-bold">{owner.name}</p>
          {(owner.company || owner.position) && (
            <p className="text-[13px] text-[#aeaeb2] mt-0.5">{[owner.position, owner.company].filter(Boolean).join(' · ')}</p>
          )}
          {owner.key_issues && (
            <p className="text-[12px] text-[#6e6e73] mt-2 border-t border-white/10 pt-2">{owner.key_issues}</p>
          )}
        </div>
      )}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
          <p className="text-[12px] text-[#aeaeb2] font-medium mb-1">残りタスク</p>
          <p className="text-[32px] font-bold text-[#1d1d1f]">{pendingTasks.length}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
          <p className="text-[12px] text-[#aeaeb2] font-medium mb-1">メモ</p>
          <p className="text-[32px] font-bold text-[#1d1d1f]">{data.memo?.length || 0}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
          <p className="text-[12px] text-[#aeaeb2] font-medium mb-1">予定</p>
          <p className="text-[32px] font-bold text-[#1d1d1f]">{data.calendar?.length || 0}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
          <p className="text-[12px] text-[#aeaeb2] font-medium mb-1">事業</p>
          <p className="text-[32px] font-bold text-[#1d1d1f]">{data.business_master?.length || 0}</p>
        </div>
      </div>
      {businesses.length > 0 && (
        <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
          <h3 className="text-[14px] font-bold text-[#1d1d1f] mb-4">事業マスタ</h3>
          <div className="grid grid-cols-2 gap-3">
            {businesses.map((b: any) => {
              const sc = STATUS_COLORS[b.status] || STATUS_COLORS['構想中']
              return (
                <div key={b.id} className="flex items-center gap-3 p-3 rounded-xl border border-[#f5f5f7]">
                  <div className={`w-2 h-2 rounded-full ${sc.dot} flex-shrink-0`} />
                  <p className="text-[13px] font-medium text-[#1d1d1f] flex-1">{b.name}</p>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-lg ${sc.bg} ${sc.text}`}>{b.status}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
        <h3 className="text-[14px] font-bold text-[#1d1d1f] mb-4">新着予定</h3>
        {upcomingEvents.length === 0 ? <p className="text-[13px] text-[#aeaeb2]">予定はありません</p> : (
          <div className="space-y-2">
            {upcomingEvents.map((e: any) => {
              const { date, time, label } = parseEventTitle(e.title)
              return (
                <div key={e.id} className="flex items-center gap-3 py-2 border-b border-[#f5f5f7] last:border-0">
                  <div className="w-2 h-2 rounded-full bg-[#0071e3] flex-shrink-0" />
                  <div>
                    <p className="text-[13px] text-[#1d1d1f]">{label}</p>
                    <p className="text-[11px] text-[#aeaeb2]">{date}{time ? ` ${time}` : ''}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
        <h3 className="text-[14px] font-bold text-[#1d1d1f] mb-4">未完了タスク</h3>
        {pendingTasks.length === 0 ? <p className="text-[13px] text-[#aeaeb2]">タスクはありません</p> : (
          <div className="space-y-2">
            {pendingTasks.slice(0, 5).map((t: any) => (
              <div key={t.id} className="flex items-center gap-3 py-2 border-b border-[#f5f5f7] last:border-0">
                <div className="w-2 h-2 rounded-full bg-[#34c759] flex-shrink-0" />
                <p className="text-[13px] text-[#1d1d1f]">{t.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="bg-white rounded-2xl p-5 border border-[#e8e8ed] shadow-sm">
        <h3 className="text-[14px] font-bold text-[#1d1d1f] mb-4">最近の保存メモ</h3>
        {recentMemos.length === 0 ? <p className="text-[13px] text-[#aeaeb2]">メモはありません</p> : (
          <div className="grid grid-cols-3 gap-3">
            {recentMemos.map((m: any) => {
              const colors = MEMO_COLORS[m.color as keyof typeof MEMO_COLORS] || MEMO_COLORS.white
              return (
                <div key={m.id} className={`${colors.bg} ${colors.border} border rounded-xl p-4`}>
                  {m.title && <p className="text-[12px] font-semibold text-[#1d1d1f] mb-1">{m.title}</p>}
                  <p className="text-[12px] text-[#6e6e73] line-clamp-3">{m.content}</p>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default function NoidaDashboard() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [data, setData] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const today = new Date().toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })

  const fetchAll = useCallback(async () => {
    const tables = ['task', 'memo', 'business', 'people', 'calendar', 'ideas', 'business_master']
    const results: any = {}
    await Promise.all(tables.map(async (table) => {
      const { data: rows } = await supabase.from(table).select('*').order('created_at', { ascending: false })
      results[table] = rows || []
    }))
    // owner_masterはcreated_atなしで別クエリ
    const { data: ownerRows } = await supabase.from('owner_master').select('*').limit(1)
    results['owner_master'] = ownerRows || []
    setData(results)
    setLoading(false)
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchAll()
    const tables = ['task', 'memo', 'business', 'people', 'calendar', 'ideas', 'business_master', 'owner_master']
    const channels = tables.map(table =>
      supabase.channel(`realtime-${table}`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, () => fetchAll())
        .subscribe()
    )
    return () => { channels.forEach(ch => supabase.removeChannel(ch)) }
  }, [fetchAll])

  return (
    <div className="flex h-screen overflow-hidden bg-[#f5f5f7]">
      <div className="w-60 flex-shrink-0 h-screen sticky top-0 bg-white border-r border-[#e8e8ed] flex flex-col pt-8 pb-6 px-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#aeaeb2] px-3 mb-1">NOIDA</p>
        <h1 className="text-[16px] font-bold text-[#1d1d1f] tracking-tight px-3 mb-6">時間を、渡す。</h1>
        <nav className="flex-1 space-y-0.5">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon
            const isActive = activeTab === item.value
            return (
              <button key={item.value} onClick={() => setActiveTab(item.value)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-150 ${isActive ? 'bg-[#f5f5f7] text-[#1d1d1f] font-semibold' : 'text-[#6e6e73] hover:bg-[#f5f5f7] hover:text-[#1d1d1f]'}`}>
                <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? item.color : 'text-[#aeaeb2]'}`} strokeWidth={1.8} />
                <span className="text-[13px] font-medium">{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="border-t border-[#f5f5f7] pt-4">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="w-2 h-2 rounded-full bg-[#34c759]" />
            <span className="text-[12px] text-[#6e6e73]">稼働中</span>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="p-8">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-[22px] font-bold text-[#1d1d1f] tracking-tight">{PAGE_TITLES[activeTab]}</h2>
            <span className="text-[12px] text-[#aeaeb2]">{today}</span>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-6 h-6 border-2 border-[#0071e3] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && <DashboardHome data={data} />}
              {activeTab === 'owner' && <OwnerMasterView items={data.owner_master || []} onRefresh={fetchAll} />}
              {activeTab === 'task' && <TaskView items={data.task || []} onRefresh={fetchAll} />}
              {activeTab === 'memo' && <MemoView items={data.memo || []} onRefresh={fetchAll} />}
              {activeTab === 'business_master' && <BusinessMasterView items={data.business_master || []} onRefresh={fetchAll} />}
              {activeTab === 'business' && <CardView items={data.business || []} onRefresh={fetchAll} table="business" color="bg-[#7c5cbf]" placeholder="ビジネス案を追加..." emptyText="ビジネス案はありません" icon={Briefcase} />}
              {activeTab === 'people' && <PeopleView items={data.people || []} onRefresh={fetchAll} />}
              {activeTab === 'calendar' && <CalendarView items={data.calendar || []} onRefresh={fetchAll} />}
              {activeTab === 'ideas' && <CardView items={data.ideas || []} onRefresh={fetchAll} table="ideas" color="bg-[#ff9f0a]" placeholder="アイデアを追加..." emptyText="アイデアはありません" icon={Lightbulb} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
