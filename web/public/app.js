(() => {
  'use strict'

  const SETTINGS_KEY = 'wmd-studio-settings-v6'
  const colors = ['#3f7f6b', '#b75b4a', '#486f9b', '#a47732', '#765899']
  const $ = (selector) => document.querySelector(selector)
  const elements = {
    source: $('#sourceEditor'), rich: $('#richEditor'), workspace: $('#workspace'), name: $('#documentName'),
    connection: $('#connectionStatus'), save: $('#saveStatus'), local: $('#localSaveStatus'), words: $('#wordCount'),
    presence: $('#presence'), editorPane: $('#editorPane'), previewPane: $('#previewZone'), resizer: $('[data-resize="split"]'),
    documentsPage: $('#documentsPage'), documentsList: $('#documentsListPage'), toast: $('#toast'), panels: $('#panelMenu'),
    style: $('#blockStyleControl'), font: $('#fontControl'), size: $('#sizeIndicator'), zoom: $('#zoomControl'),
    insert: $('#insertDialog'), find: $('#findDialog'), confirm: $('#confirmDialog'),
  }
  let studio = null
  let settings = loadSettings()
  let documentId = normalizeId(new URLSearchParams(location.search).get('doc') || 'untitled')
  let documentTitle = ''
  let styles = []
  let selection = { mode: 'document', marks: [], block: 'paragraph', level: null }
  let toastTimer = null
  let insertKind = ''
  let findCursor = 0
  let pendingConfirmation = null
  let dragging = false
  let highlightLevel = 1

  function defaults () {
    return { username: 'Guest ' + Math.floor(100 + Math.random() * 900), color: colors[Math.floor(Math.random() * colors.length)],
      syncUrl: '', theme: 'light', accent: 'green', zoom: 100, panes: { editor: null }, panels: { editor: true, preview: true }, macros: [] }
  }

  function loadSettings () {
    try {
      const fallback = defaults()
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
      return { ...fallback, ...stored, panes: { ...fallback.panes, ...(stored.panes || {}) }, panels: { ...fallback.panels, ...(stored.panels || {}) } }
    } catch (_) { return defaults() }
  }

  function saveSettings () { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) }
  function normalizeId (value) { return String(value || '').toLowerCase().replace(/\.[^./\\]+$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'untitled' }
  function styleId (name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-style' }
  function escapeHtml (value) { return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]) }
  function toast (message) { elements.toast.textContent = message; elements.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2800) }

  function collaborationUrl () {
    const base = new URL(settings.syncUrl || location.href, location.href)
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    base.pathname = (base.pathname.replace(/\/$/, '') + '/collaboration').replace(/\/\/+/g, '/')
    base.search = ''; base.hash = ''
    return base.toString().replace(/\/$/, '')
  }

  async function request (url, options) {
    const response = await fetch(url, options)
    const value = await response.json()
    if (!response.ok) throw new Error(value.error || 'Request failed.')
    return value
  }

  function parseProperties (body) {
    const values = {}
    let previous = ''
    for (const part of String(body || '').split(';')) {
      const item = part.trim()
      if (!item) {
        if (previous === 'keybind' && /\+$/.test(values[previous] || '')) values[previous] += ';'
        continue
      }
      const match = item.match(/^([a-z][\w-]*)\s*:\s*([\s\S]*)$/i)
      if (match) { previous = match[1].toLowerCase(); values[previous] = match[2].trim() } else if (previous) values[previous] += ';' + item
    }
    return values
  }

  function parseStyles (source) {
    const config = String(source || '').match(/^@config\s*$([\s\S]*?)^@endconfig\s*$/mi)
    if (!config) return []
    return config[1].split(/\r?\n/).map((line) => {
      const match = line.match(/^\s*([^:]+?)\s*:\s*\{([\s\S]*)\}\s*;?\s*$/)
      if (!match) return null
      const props = parseProperties(match[2])
      const formatting = String(props['wmd-formatting'] || '')
      const heading = formatting.match(/^(#{1,6})$/)
      const trueValue = (value) => /^(true|yes|1)$/i.test(value || '')
      return { id: styleId(match[1]), name: match[1].trim(), formatting, keybind: String(props.keybind || '').toLowerCase(),
        size: props.size || '', font: props.font || '', bold: trueValue(props.bold), italic: trueValue(props.italic),
        underline: trueValue(props.underline), strike: trueValue(props.strikethrough || props.strike),
        level: heading ? heading[1].length : null, properties: props }
    }).filter(Boolean)
  }

  function currentStyle () {
    if (selection.block === 'wmd_title') return styles.find((item) => item.formatting.toLowerCase() === '@title') || null
    if (selection.style) return styles.find((item) => item.id === selection.style) || null
    if (selection.block === 'heading') return styles.find((item) => item.level === Number(selection.level)) || null
    return styles.find((item) => /^(normal text|body)$/i.test(item.name) || !item.formatting) || styles[0] || null
  }

  function renderStyleOptions () {
    const selected = currentStyle()
    elements.style.replaceChildren()
    styles.forEach((style) => {
      const option = document.createElement('option')
      option.value = style.id; option.textContent = style.name; elements.style.append(option)
    })
    const create = document.createElement('option')
    create.value = '__new__'; create.textContent = 'Create custom style…'; elements.style.append(create)
    if (selected) elements.style.value = selected.id
  }

  function applyConfigStyles () {
    const rules = []
    styles.forEach((style) => {
      const declarations = []
      const clean = (value) => String(value || '').replace(/[{};]/g, '').trim()
      if (style.font) declarations.push('font-family:' + clean(style.font))
      if (style.size) declarations.push('font-size:' + clean(style.size))
      if (style.bold) declarations.push('font-weight:700')
      if (style.italic) declarations.push('font-style:italic')
      const decoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ')
      if (decoration) declarations.push('text-decoration-line:' + decoration)
      if (!declarations.length) return
      let selector = ''
      if (!style.formatting) selector = '#richEditor .ProseMirror'
      else if (style.formatting.toLowerCase() === '@title') selector = '#richEditor .wmd-title'
      else if (style.level) selector = '#richEditor h' + style.level + ':not(.wmd-title)'
      else if (/^heading/i.test(style.name)) selector = '#richEditor [data-wmd-style="' + style.id + '"]'
      if (selector) rules.push(selector + '{' + declarations.join(';') + '}')
    })
    let tag = $('#configStyleSheet')
    if (!tag) { tag = document.createElement('style'); tag.id = 'configStyleSheet'; document.head.append(tag) }
    tag.textContent = rules.join('\n')
  }

  function updateToolbar () {
    const marks = new Map((selection.marks || []).map((mark) => [mark.name, mark]))
    document.querySelectorAll('[data-command]').forEach((button) => {
      const command = button.dataset.command
      const mark = ({ bold: 'strong', italic: 'em', underline: 'underline', strikeThrough: 'strike' })[command]
      const level = command === 'highlight' ? Number(marks.get('highlight')?.attrs?.level || highlightLevel) : 0
      if (level) highlightLevel = level
      button.classList.toggle('active', mark ? marks.has(mark) : command === 'highlight' ? marks.has('highlight') : false)
      if (command === 'highlight') {
        const names = ['Yellow', 'Orange', 'Red']
        button.textContent = 'Highlight: ' + names[highlightLevel - 1]
        button.dataset.highlightLevel = String(highlightLevel)
      }
    })
    const style = currentStyle()
    if (style) {
      elements.style.value = style.id
      if ([...elements.font.options].some((option) => option.value.toLowerCase() === style.font.toLowerCase())) elements.font.value = style.font
      elements.size.textContent = String(Number.parseFloat(style.size) || 16)
    }
  }

  function updateSourceStatus (source, ast) {
    elements.words.textContent = (source.match(/[\p{L}\p{N}_-]+/gu) || []).length + ' words'
    elements.local.textContent = ast.diagnostics?.length ? ast.diagnostics.length + ' recoverable WMD issue' + (ast.diagnostics.length === 1 ? '' : 's') : 'Local copy ready'
    elements.save.textContent = 'Saving collaborative snapshot…'
    clearTimeout(updateSourceStatus.timer)
    updateSourceStatus.timer = setTimeout(() => { elements.save.textContent = 'Yjs state synced' }, 500)
    styles = parseStyles(source); renderStyleOptions(); applyConfigStyles()
  }

  function onSelection (next) { selection = next; updateToolbar() }
  function renderPresence (states) {
    elements.presence.replaceChildren()
    states.forEach((state, id) => {
      const user = state.user || {}
      const avatar = document.createElement('button')
      avatar.className = 'avatar'; avatar.disabled = true
      avatar.textContent = String(user.name || 'User ' + id).slice(0, 1).toUpperCase()
      avatar.title = (user.name || 'Collaborator') + ' (' + (state.mode || 'document') + ')'
      avatar.style.background = /^#[0-9a-f]{6}$/i.test(user.color || '') ? user.color : '#3f7f6b'
      elements.presence.append(avatar)
    })
  }

  function followLink (href) {
    if (!href) return
    if (href.startsWith('wiki:')) {
      const url = new URL(location.href); url.searchParams.set('doc', normalizeId(href.slice(5))); location.assign(url); return
    }
    if (href.startsWith('#')) { location.hash = href; return }
    location.assign(href)
  }

  async function openDocument (id, sourceOverride) {
    documentId = normalizeId(id)
    const url = new URL(location.href); url.searchParams.set('doc', documentId); history.replaceState({}, '', url)
    if (studio) await studio.destroy()
    elements.source.replaceChildren(); elements.rich.replaceChildren()
    elements.name.textContent = 'Loading…'; elements.connection.textContent = 'Connecting'
    const remote = sourceOverride == null ? await request('/api/documents/' + encodeURIComponent(documentId)) : { document: { source: sourceOverride, title: documentId } }
    documentTitle = remote.document.title || documentId.replace(/[-_]+/g, ' ')
    elements.name.textContent = documentTitle; document.title = documentTitle + ' | WMD Studio'
    studio = await globalThis.WmdCollaborativeEditor.createCollaborativeEditor({
      sourceRoot: elements.source, richRoot: elements.rich, source: remote.document.source, documentId, websocketUrl: collaborationUrl(),
      user: { name: settings.username, color: settings.color },
      onStatus: (status) => { elements.connection.textContent = status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'; elements.connection.dataset.status = status },
      onSource: updateSourceStatus, onAwareness: renderPresence, onSelection, onLink: followLink,
    })
    updateSourceStatus(studio.getSource(), studio.getAst()); applyPaneLayout()
  }

  function updateStyle (style, changes) {
    if (!style || !studio) return
    const next = { ...style, ...changes }
    const props = { ...style.properties,
      'wmd-formatting': next.formatting || '', keybind: next.keybind || '', size: next.size || '', font: next.font || '',
      bold: next.bold ? 'true' : 'false', italic: next.italic ? 'true' : 'false', underline: next.underline ? 'true' : 'false',
      strikethrough: next.strike ? 'true' : 'false' }
    const line = next.name + ': {' + Object.entries(props).map(([key, value]) => key + ': ' + value).join('; ') + '};'
    const source = studio.getSource()
    const block = source.match(/^@config\s*$([\s\S]*?)^@endconfig\s*$/mi)
    const lines = block ? block[1].split(/\r?\n/) : []
    const index = lines.findIndex((candidate) => styleId((candidate.match(/^\s*([^:]+):/) || [])[1]) === style.id)
    if (index >= 0) lines[index] = line; else lines.push(line)
    const nextSource = block
      ? source.slice(0, block.index) + '@config\n' + lines.filter(Boolean).join('\n') + '\n@endconfig' + source.slice(block.index + block[0].length)
      : '@config\n' + line + '\n@endconfig\n\n' + source
    studio.setSource(nextSource)
  }

  function toggleFormatting (command) {
    const style = currentStyle()
    const field = ({ bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strike' })[command]
    if (style && (selection.block === 'heading' || selection.block === 'wmd_title' || style.formatting.startsWith('@'))) { updateStyle(style, { [field]: !style[field] }); return }
    const mark = ({ bold: 'strong', italic: 'em', underline: 'underline', strikeThrough: 'strike' })[command]
    if (mark) studio.toggleMark(mark)
  }

  function tableWmd (rows, columns, alignments = '') {
    const count = Math.max(1, Number(columns) || 1)
    const header = Array.from({ length: count }, (_, index) => ' Column ' + (index + 1) + ' ').join('|')
    const directions = String(alignments || '').split(',').map((value) => value.trim().toLowerCase())
    const divider = Array.from({ length: count }, (_, index) => {
      const direction = directions[index] || directions[0] || ''
      return direction === 'center' || direction === 'centre' ? ' :---: ' : direction === 'right' ? ' ---: ' : direction === 'left' ? ' :--- ' : ' --- '
    }).join('|')
    const body = Array.from({ length: Math.max(1, Number(rows) || 1) }, () => '|' + Array.from({ length: count }, () => ' ').join('|') + '|').join('\n')
    return '\n\n|' + header + '|\n|' + divider + '|\n' + body + '\n'
  }

  function field (label, name, options = {}) {
    const wrapper = document.createElement('label'); wrapper.textContent = label
    const input = document.createElement('input')
    input.name = name; input.required = Boolean(options.required); input.type = options.type || 'text'
    if (options.value != null) input.value = options.value
    if (options.min != null) input.min = String(options.min)
    if (options.max != null) input.max = String(options.max)
    if (input.type === 'checkbox') input.checked = Boolean(options.checked)
    wrapper.append(input); return wrapper
  }

  function openInsert (kind) {
    insertKind = kind
    const fields = $('#insertFields'); fields.replaceChildren()
    const title = { link: 'Insert link', image: 'Insert image', table: 'Insert table', callout: 'Insert callout', tab: 'Insert tab', style: 'Create custom style' }[kind] || 'Insert'
    $('#insertDialogTitle').textContent = title
    $('#insertDialogDescription').textContent = kind === 'table' ? 'Choose the table dimensions. You can edit every cell afterwards.' : kind === 'style' ? 'This style is written into @config for every collaborator.' : ''
    if (kind === 'link') fields.append(field('Text', 'text', { required: true }), field('Address', 'href', { required: true }))
    else if (kind === 'image') fields.append(field('Alternative text', 'alt'), field('Image URL', 'src', { required: true }))
    else if (kind === 'table') {
      const grid = document.createElement('div'); grid.className = 'dimension-grid'
      grid.append(field('Rows', 'rows', { type: 'number', value: 3, min: 1, max: 100 }), field('Columns', 'columns', { type: 'number', value: 3, min: 1, max: 100 }), field('Alignment (left, center, right)', 'alignments', { value: 'left, center, right' })); fields.append(grid)
    } else if (kind === 'callout') fields.append(field('Type', 'type', { value: 'note' }), field('Title', 'title', { value: 'Note' }), field('Text', 'text'))
    else if (kind === 'tab') fields.append(field('Tab name', 'name', { required: true }), field('Document title', 'title', { required: true }))
    else if (kind === 'style') fields.append(field('Style name', 'name', { required: true }), field('WMD marker (for example # or @headingA)', 'formatting', { value: '@style' }), field('Keybind', 'keybind', { value: 'ctrl+shift+' }), field('Size', 'size', { value: '24px' }), field('Font', 'font', { value: 'Arial, sans-serif' }), field('Bold', 'bold', { type: 'checkbox' }), field('Italic', 'italic', { type: 'checkbox' }))
    elements.insert.showModal(); fields.querySelector('input')?.focus()
  }

  function inputValue (name) {
    const input = $('#insertFields').querySelector('[name="' + name + '"]')
    return input && input.type === 'checkbox' ? input.checked : input ? input.value.trim() : ''
  }

  function submitInsert () {
    if (insertKind === 'link') studio.insertLink(inputValue('text'), inputValue('href'))
    else if (insertKind === 'image') studio.insertImage(inputValue('alt'), inputValue('src'))
    else if (insertKind === 'table') studio.insertRaw(tableWmd(inputValue('rows'), inputValue('columns'), inputValue('alignments')), 'table')
    else if (insertKind === 'callout') studio.insertRaw('\n\n!' + (inputValue('type') || 'note') + ' ' + (inputValue('title') || 'Note') + '\n' + inputValue('text') + '\n!end\n', 'callout')
    else if (insertKind === 'tab') studio.insertRaw('\n@tab ' + inputValue('name') + '\n@title ' + inputValue('title') + '\n\n# ' + inputValue('title') + '\n', 'tab')
    else if (insertKind === 'style') {
      const name = inputValue('name')
      const custom = { id: styleId(name), name, formatting: inputValue('formatting'), keybind: inputValue('keybind'), size: inputValue('size'), font: inputValue('font'), bold: inputValue('bold'), italic: inputValue('italic'), properties: {} }
      updateStyle(custom, custom)
    }
    elements.insert.close()
  }

  function showFind (replace) {
    elements.find.showModal()
    $('#replaceInput').closest('label').hidden = !replace; $('#replaceButton').hidden = !replace; $('#replaceAllButton').hidden = !replace
    $('#findInput').focus(); $('#findInput').select()
  }

  function findNext () {
    const query = $('#findInput').value
    if (!query || !studio) return
    const source = studio.getSource()
    let index = source.indexOf(query, findCursor)
    if (index < 0 && findCursor) index = source.indexOf(query)
    if (index < 0) { $('#findStatus').textContent = 'No matches.'; return }
    findCursor = index + query.length; studio.selectSourceRange(index, index + query.length); $('#findStatus').textContent = 'Match at character ' + (index + 1) + '.'
  }

  function replaceCurrent () {
    const query = $('#findInput').value
    if (!query) return
    const source = studio.getSource(); const index = Math.max(0, findCursor - query.length)
    if (source.slice(index, index + query.length) !== query) { findNext(); return }
    const replacement = $('#replaceInput').value
    studio.replaceSourceRange(index, index + query.length, replacement); findCursor = index + replacement.length; findNext()
  }

  function replaceAll () {
    const query = $('#findInput').value
    if (!query) return
    const source = studio.getSource(); const count = source.split(query).length - 1
    studio.setSource(source.split(query).join($('#replaceInput').value)); findCursor = 0; $('#findStatus').textContent = count + ' match' + (count === 1 ? '' : 'es') + ' replaced.'
  }

  function openTitleEditor () {
    if (elements.name.querySelector('input')) return
    const input = document.createElement('input'); input.className = 'document-title-input'; input.value = documentTitle; elements.name.replaceChildren(input); input.focus(); input.select()
    const save = async () => {
      const title = input.value.trim() || documentTitle; elements.name.textContent = title
      if (title === documentTitle) return
      try { await request('/api/documents/' + encodeURIComponent(documentId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }); documentTitle = title; document.title = title + ' | WMD Studio' } catch (error) { elements.name.textContent = documentTitle; toast(error.message) }
    }
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); input.blur() } else if (event.key === 'Escape') { input.value = documentTitle; input.blur() } })
    input.addEventListener('blur', save, { once: true })
  }

  function applyPaneLayout () {
    const editorVisible = settings.panels.editor !== false; const previewVisible = settings.panels.preview !== false
    elements.editorPane.hidden = !editorVisible; elements.previewPane.hidden = !previewVisible; elements.resizer.hidden = !editorVisible || !previewVisible
    if (editorVisible && previewVisible) {
      const width = elements.workspace.clientWidth; const saved = Number(settings.panes.editor); const paneWidth = Number.isFinite(saved) ? Math.max(0, Math.min(width, saved)) : width / 2
      elements.workspace.style.gridTemplateColumns = 'minmax(0, ' + paneWidth + 'px) 8px minmax(0, 1fr)'
    } else elements.workspace.style.gridTemplateColumns = 'minmax(0, 1fr)'
    document.querySelectorAll('[data-panel-toggle]').forEach((input) => { input.checked = settings.panels[input.dataset.panelToggle] !== false })
  }

  function applyAppearance () {
    document.body.dataset.theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme
    document.body.dataset.accent = settings.accent
    const zoom = Math.max(25, Number(settings.zoom) || 100)
    elements.workspace.style.zoom = String(zoom / 100); elements.workspace.style.width = 10000 / zoom + '%'; elements.zoom.textContent = zoom + '%'
    setTimeout(() => studio && studio.requestMeasure(), 0)
  }

  function confirmInPage (message, label, action) {
    pendingConfirmation = action; $('#confirmMessage').textContent = message; $('#confirmActionButton').textContent = label; elements.confirm.showModal()
  }

  async function refreshDocuments () {
    const data = await request('/api/documents'); elements.documentsList.replaceChildren()
    if (!data.documents.length) { const empty = document.createElement('div'); empty.className = 'documents-empty'; empty.textContent = 'No saved documents yet. Create one above.'; elements.documentsList.append(empty); return }
    data.documents.forEach((item) => {
      const row = document.createElement('article'); row.className = 'document-card' + (item.id === documentId ? ' document-card-current' : '')
      const main = document.createElement('div'); main.className = 'document-card-main'; main.innerHTML = '<div class="document-card-title">' + escapeHtml(item.title || item.id) + '</div><div class="document-card-meta">' + escapeHtml(item.id) + '.wmd</div>'
      const actions = document.createElement('div'); actions.className = 'document-card-actions'
      const open = document.createElement('button'); open.className = 'primary-button'; open.type = 'button'; open.textContent = item.id === documentId ? 'Current' : 'Open'; open.disabled = item.id === documentId
      open.addEventListener('click', async () => { elements.documentsPage.hidden = true; await openDocument(item.id) })
      const remove = document.createElement('button'); remove.className = 'quiet-button document-delete-button'; remove.type = 'button'; remove.textContent = 'Delete'; remove.disabled = item.id === 'untitled' || item.id === documentId
      remove.addEventListener('click', () => confirmInPage('Delete “' + (item.title || item.id) + '”? This cannot be undone.', 'Delete', async () => {
        try { await request('/api/documents/' + encodeURIComponent(item.id), { method: 'DELETE' }); await refreshDocuments() } catch (error) { toast(error.message) }
      }))
      actions.append(open, remove); row.append(main, actions); elements.documentsList.append(row)
    })
  }

  function download () {
    const blob = new Blob([studio.getSource()], { type: 'text/plain;charset=utf-8' }); const link = document.createElement('a')
    link.href = URL.createObjectURL(blob); link.download = documentId + '.wmd'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0)
  }

  function normalizeShortcut (value) { return String(value || '').toLowerCase().replace(/\s/g, '').replace('control', 'ctrl').replace('command', 'meta') }
  function shortcutFromEvent (event) { return (event.ctrlKey ? 'ctrl+' : '') + (event.metaKey ? 'meta+' : '') + (event.altKey ? 'alt+' : '') + (event.shiftKey ? 'shift+' : '') + event.key.toLowerCase() }
  function runStyleShortcut (style) {
    if (style.level) studio.setHeadingStyle(style)
    else if (style.formatting.toLowerCase() === '@title') toast('Title style is reserved for the document title directive.')
    else if (style.formatting.startsWith('@')) studio.insertRaw('\n' + style.formatting + ' ' + style.name + '\n', 'style')
    else if (style.formatting) studio.insertText(style.formatting)
  }

  function wireUi () {
    $('#downloadButton').addEventListener('click', download); elements.name.addEventListener('click', openTitleEditor)
    elements.rich.addEventListener('change', (event) => {
      const checkbox = event.target
      if (!checkbox || !checkbox.matches || !checkbox.matches('input[data-wmd-task]')) return
      const list = checkbox.closest('[data-wmd-id]')
      if (!list) return
      const index = [...list.querySelectorAll('input[data-wmd-task]')].indexOf(checkbox)
      if (index >= 0) studio.toggleChecklistItem(list.dataset.wmdId, index, checkbox.checked)
    })
    elements.rich.addEventListener('focusout', (event) => {
      const target = event.target
      if (!target || !target.matches) return
      const tableCell = target.matches('[data-wmd-table-cell]') ? target : null
      if (tableCell) {
        const table = tableCell.closest('[data-wmd-id]')
        const coordinates = tableCell.dataset.wmdTableCell.split(':').map(Number)
        if (table && coordinates.length === 2) studio.updateTableCell(table.dataset.wmdId, coordinates[0], coordinates[1], tableCell.textContent)
        return
      }
      const listItem = target.matches('[data-wmd-list-item]') ? target : null
      if (listItem) {
        const list = listItem.closest('[data-wmd-id]')
        if (list) studio.updateListItem(list.dataset.wmdId, Number(listItem.dataset.wmdListItem), listItem.textContent)
      }
    })
    $('#documentsButton').addEventListener('click', async () => { elements.documentsPage.hidden = false; await refreshDocuments() }); $('#backToEditorButton').addEventListener('click', () => { elements.documentsPage.hidden = true }); $('#refreshDocumentsButton').addEventListener('click', refreshDocuments)
    $('#documentsCreateForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await request('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#newDocumentName').value }) }); $('#newDocumentName').value = ''; elements.documentsPage.hidden = true; await openDocument(result.document.id) } catch (error) { toast(error.message) } })
    $('#uploadButton').addEventListener('click', () => $('#importInput').click())
    $('#importInput').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0]; if (!file) return
      try { let source; if (/\.docx$/i.test(file.name)) { const data = await file.arrayBuffer(); source = (await request('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, data: btoa(String.fromCharCode(...new Uint8Array(data))) }) })).source } else source = await file.text(); studio.setSource(source); toast('Imported into this document.') } catch (error) { toast(error.message) }
      event.target.value = ''
    })
    $('#settingsButton').addEventListener('click', () => { $('#usernameInput').value = settings.username; $('#syncUrlInput').value = settings.syncUrl; $('#cursorColorInput').value = settings.color; $('#themeInput').value = settings.theme; $('#accentInput').value = settings.accent; $('#settingsDialog').showModal() })
    $('#settingsForm').addEventListener('submit', (event) => { event.preventDefault(); settings = { ...settings, username: $('#usernameInput').value.trim().slice(0, 36) || 'Guest', syncUrl: $('#syncUrlInput').value.trim(), color: $('#cursorColorInput').value, theme: $('#themeInput').value, accent: $('#accentInput').value }; saveSettings(); applyAppearance(); studio.setUser({ name: settings.username, color: settings.color }); $('#settingsDialog').close(); toast('Settings saved.') })
    $('#shareButton').addEventListener('click', () => { $('#shareLinkInput').value = location.href; $('#shareDialog').showModal() }); $('#selectShareLinkButton').addEventListener('click', () => $('#shareLinkInput').select())
    $('#copyShareLinkButton').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#shareLinkInput').value); toast('Share link copied.') } catch (_) { $('#shareLinkInput').select(); toast('Link selected for copying.') } })
    $('#panelsButton').addEventListener('click', () => { elements.panels.hidden = !elements.panels.hidden; $('#panelsButton').setAttribute('aria-expanded', String(!elements.panels.hidden)) }); $('#closePanelsButton').addEventListener('click', () => { elements.panels.hidden = true })
    document.querySelectorAll('[data-panel-toggle]').forEach((input) => input.addEventListener('change', () => { settings.panels[input.dataset.panelToggle] = input.checked; saveSettings(); applyPaneLayout() }))
    elements.resizer.addEventListener('pointerdown', (event) => { if (elements.resizer.hidden) return; dragging = true; elements.resizer.classList.add('dragging'); elements.resizer.setPointerCapture(event.pointerId); document.body.style.userSelect = 'none' })
    elements.resizer.addEventListener('pointermove', (event) => { if (!dragging) return; const rect = elements.workspace.getBoundingClientRect(); settings.panes.editor = Math.max(0, Math.min(rect.width, event.clientX - rect.left)); applyPaneLayout() })
    elements.resizer.addEventListener('pointerup', () => { dragging = false; elements.resizer.classList.remove('dragging'); document.body.style.userSelect = ''; saveSettings() })
    document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => {
      const command = button.dataset.command
      if (command === 'undo') studio.undo()
      else if (command === 'redo') studio.redo()
      else if (command === 'highlight') {
        const active = (selection.marks || []).find((mark) => mark.name === 'highlight')
        highlightLevel = active ? Number(active.attrs.level || 1) % 3 + 1 : 1
        studio.toggleHighlight(highlightLevel); updateToolbar()
      }
      else toggleFormatting(command)
    }))
    document.querySelectorAll('[data-insert]').forEach((button) => button.addEventListener('click', () => { const kind = button.dataset.insert; if (kind === 'heading') studio.setHeading(2); else if (kind === 'list') studio.insertRaw('\n\n- First item\n- Second item\n', 'list'); else if (kind === 'ordered-list') studio.insertRaw('\n\n1. First item\n2. Second item\n', 'list'); else if (kind === 'checkbox') studio.insertRaw('\n\n- [ ] Task\n', 'checklist'); else openInsert(kind) }))
    elements.style.addEventListener('change', () => { const style = styles.find((item) => item.id === elements.style.value); if (elements.style.value === '__new__') { openInsert('style'); renderStyleOptions() } else if (style) runStyleShortcut(style) })
    elements.font.addEventListener('change', () => { const style = currentStyle(); if (style) updateStyle(style, { font: elements.font.value }) })
    document.querySelectorAll('[data-document-command]').forEach((button) => button.addEventListener('click', () => { settings.zoom = Math.max(25, (settings.zoom || 100) + (button.dataset.documentCommand.includes('in') || button.dataset.documentCommand === 'size-up' ? 10 : -10)); saveSettings(); applyAppearance() }))
    elements.zoom.addEventListener('click', () => { settings.zoom = 100; saveSettings(); applyAppearance() })
    $('#findReplaceButton').addEventListener('click', () => showFind(true)); $('#findNextButton').addEventListener('click', findNext); $('#replaceButton').addEventListener('click', replaceCurrent); $('#replaceAllButton').addEventListener('click', replaceAll); $('#findInput').addEventListener('input', () => { findCursor = 0 })
    $('#insertForm').addEventListener('submit', (event) => { event.preventDefault(); submitInsert() }); $('#confirmForm').addEventListener('submit', async (event) => { event.preventDefault(); const action = pendingConfirmation; pendingConfirmation = null; elements.confirm.close(); if (action) await action() }); $('#confirmCancelButton').addEventListener('click', () => { pendingConfirmation = null })
    document.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => {
      const dialog = button.closest('dialog')
      if (dialog) dialog.close()
    }))
    document.addEventListener('keydown', (event) => {
      const target = event.target; if (target && target.closest && target.closest('input,select,textarea') && !target.closest('.cm-content')) return
      const shortcut = shortcutFromEvent(event)
      if (shortcut === 'ctrl+f' || shortcut === 'meta+f') { event.preventDefault(); showFind(false); return }
      if (shortcut === 'ctrl+h' || shortcut === 'meta+shift+h') { event.preventDefault(); showFind(true); return }
      const custom = styles.find((style) => normalizeShortcut(style.keybind) === normalizeShortcut(shortcut))
      if (custom) { event.preventDefault(); runStyleShortcut(custom); return }
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'b') { event.preventDefault(); toggleFormatting('bold') } else if (key === 'i') { event.preventDefault(); toggleFormatting('italic') } else if (key === 'u') { event.preventDefault(); toggleFormatting('underline') } else if (key === 'k') { event.preventDefault(); openInsert('link') }
    }, true)
  }

  window.addEventListener('beforeunload', () => { if (studio) studio.destroy() }); window.addEventListener('resize', applyPaneLayout)
  wireUi(); applyAppearance(); openDocument(documentId).catch((error) => { elements.connection.textContent = 'Error'; toast(error.message) })
})()
