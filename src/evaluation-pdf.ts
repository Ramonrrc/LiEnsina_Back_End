import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import type { ClassRoom, Evaluation, Question } from './liensina.types'

type PrintableImage = {
  source: string
  alt: string
}

type PdfImageInput = Buffer | string
type PdfImageInfo = {
  width: number
  height: number
}
type ResolvedPrintableImage = PrintableImage & {
  input: PdfImageInput | null
}
type OptionRowMetrics = {
  labelWidth: number
  contentX: number
  contentWidth: number
  maxImageWidth: number
  maxImageHeight: number
  imageGap: number
  resolvedImages: ResolvedPrintableImage[]
  displayText: string
  textHeight: number
  rowHeight: number
}
type PreparedOptionRow = {
  option: Question['options'][number]
  optionText: string
  optionImages: PrintableImage[]
}

export type EvaluationPdfInput = {
  evaluation: Evaluation
  classRoom?: ClassRoom
  questions: Question[]
  uploadsRoot: string
}

const markdownImagePattern = /!\[([^\]]*)\]\(((?:https?:\/\/|data:image\/)[^\s)]+)\)/gi
const controlCharPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const questionImageMaxHeight = 175
const questionImageGrowMaxHeight = 330
const questionImageMinWidth = 300
const questionImageMinHeight = 190
const omrTemplateVersion = 'liensina-omr-v1'
const omrCanonicalWidth = 1100
const omrCanonicalHeight = 1550
const omrMarkerSize = 58
const omrMarkerMargin = 54
const omrGridTop = 360
const omrGridBottomMargin = 120
const omrGridLeft = 88
const omrOptions = ['A', 'B', 'C', 'D', 'E']

function cleanText(value: unknown) {
  return String(value ?? '').normalize('NFC').replace(controlCharPattern, '').replace(/[ \t]{2,}/g, ' ').trim()
}

function formatDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? cleanText(value) : new Intl.DateTimeFormat('pt-BR').format(date)
}

function extractMarkdownImages(value?: string | null) {
  const images: PrintableImage[] = []
  const text = String(value ?? '').replace(markdownImagePattern, (_match, alt, source) => {
    images.push({ source: String(source), alt: cleanText(alt) || 'Imagem da questão' })
    return '\n'
  })

  return { text: cleanText(text.replace(/\n{3,}/g, '\n\n')), images }
}

function getAttachmentImages(question: Question, positions: string[]) {
  return (question.attachments ?? [])
    .filter((attachment) => attachment.fileType === 'IMAGE' && positions.includes(attachment.position))
    .map((attachment) => ({ source: attachment.fileUrl, alt: cleanText(attachment.altText) || 'Imagem da questão' }))
}

function getOptionAttachmentImages(question: Question) {
  return (question.attachments ?? [])
    .filter((attachment) => attachment.fileType === 'IMAGE' && attachment.position === 'OPTION')
    .sort((first, second) => first.order - second.order)
    .map((attachment) => ({
      order: attachment.order,
      image: {
        source: attachment.fileUrl,
        alt: cleanText(attachment.altText) || 'Imagem da alternativa',
      },
    }))
}

function normalizeComparableText(value?: string | null) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isOptionImagePlaceholderText(value: string, label: string) {
  const text = normalizeComparableText(value)
  const optionLabel = normalizeComparableText(label)

  return [
    `imagem da alternativa ${optionLabel}`,
    `imagem alternativa ${optionLabel}`,
    `alternativa ${optionLabel} imagem`,
    `alternativa com imagem`,
  ].includes(text)
}

function getImagesForOption(
  optionAttachments: ReturnType<typeof getOptionAttachmentImages>,
  option: Question['options'][number],
  optionIndex: number,
  totalOptions: number,
) {
  const orderedImages = optionAttachments
    .filter((attachment) => attachment.order === option.order)
    .map((attachment) => attachment.image)

  if (orderedImages.length > 0) return orderedImages
  if (optionAttachments.length !== totalOptions) return []

  return optionAttachments[optionIndex]?.image ? [optionAttachments[optionIndex].image] : []
}

function uniqueImages(images: PrintableImage[]) {
  const seen = new Set<string>()
  const output: PrintableImage[] = []

  for (const image of images) {
    const source = cleanText(image.source)
    if (!source || seen.has(source)) continue
    seen.add(source)
    output.push({ source, alt: image.alt })
  }

  return output
}

function resolveLocalUpload(source: string, uploadsRoot: string) {
  if (!source.startsWith('/uploads/')) return null

  const filePath = resolve(process.cwd(), source.replace(/^\/+/, ''))
  const safeUploadsRoot = resolve(uploadsRoot)
  if (filePath !== safeUploadsRoot && !filePath.startsWith(`${safeUploadsRoot}${sep}`)) return null

  return existsSync(filePath) ? filePath : null
}

function resolveImageInput(source: string, uploadsRoot: string) {
  const dataUrlMatch = source.match(/^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\s]+)$/i)
  if (dataUrlMatch) return Buffer.from(dataUrlMatch[1].replace(/\s/g, ''), 'base64')

  return resolveLocalUpload(source, uploadsRoot)
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height <= doc.page.height - doc.page.margins.bottom) return
  doc.addPage()
}

function getPageContentWidth(doc: PDFKit.PDFDocument) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right
}

function getPageContentHeight(doc: PDFKit.PDFDocument) {
  return doc.page.height - doc.page.margins.top - doc.page.margins.bottom
}

function ensureBlockStartsOnSamePage(doc: PDFKit.PDFDocument, blockHeight: number) {
  if (blockHeight > getPageContentHeight(doc)) return
  ensureSpace(doc, blockHeight)
}

function getPdfImageInfo(doc: PDFKit.PDFDocument, input: PdfImageInput) {
  return (doc as unknown as { openImage(source: PdfImageInput): PdfImageInfo }).openImage(input)
}

function fitImageSize(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (width <= 0 || height <= 0) return { width: maxWidth, height: maxHeight }

  const scale = Math.min(maxWidth / width, maxHeight / height)
  return {
    width: width * scale,
    height: height * scale,
  }
}

function growSmallQuestionImageSize(size: { width: number; height: number }, maxWidth: number) {
  const growScale = Math.max(
    size.width < questionImageMinWidth ? questionImageMinWidth / size.width : 1,
    size.height < questionImageMinHeight ? questionImageMinHeight / size.height : 1,
  )

  if (growScale <= 1) return size

  const cappedScale = Math.min(
    growScale,
    maxWidth / size.width,
    questionImageGrowMaxHeight / size.height,
  )

  return {
    width: size.width * cappedScale,
    height: size.height * cappedScale,
  }
}

function getQuestionImageSize(doc: PDFKit.PDFDocument, input: PdfImageInput) {
  const pageWidth = getPageContentWidth(doc)
  const maxWidth = Math.min(500, pageWidth)
  const image = getPdfImageInfo(doc, input)
  const fitted = fitImageSize(image.width, image.height, maxWidth, questionImageMaxHeight)

  return growSmallQuestionImageSize(fitted, maxWidth)
}

function measureTitleHeight(doc: PDFKit.PDFDocument, value: string) {
  doc.font('Helvetica-Bold').fontSize(12)
  return doc.heightOfString(value, { width: getPageContentWidth(doc), lineGap: 1.5 }) + 10
}

function measureTextHeight(doc: PDFKit.PDFDocument, value?: string | null) {
  const text = cleanText(value)
  if (!text) return 0

  doc.font('Helvetica').fontSize(10)
  return doc.heightOfString(text, {
    width: getPageContentWidth(doc),
    align: 'justify',
    lineGap: 2,
  }) + 9
}

function measureQuestionImagesHeight(doc: PDFKit.PDFDocument, images: PrintableImage[], uploadsRoot: string) {
  let height = 0

  for (const image of uniqueImages(images)) {
    const input = resolveImageInput(image.source, uploadsRoot)
    if (!input) continue

    try {
      height += getQuestionImageSize(doc, input).height + 12
    } catch {
      height += 24
    }
  }

  return height
}

function addTitle(doc: PDFKit.PDFDocument, value: string) {
  ensureSpace(doc, 34)
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(value, doc.page.margins.left, doc.y, {
    align: 'left',
    width: getPageContentWidth(doc),
    lineGap: 1.5,
  })
  doc.x = doc.page.margins.left
  doc.moveDown(0.35)
}

function addText(doc: PDFKit.PDFDocument, value?: string | null) {
  const text = cleanText(value)
  if (!text) return

  ensureSpace(doc, 42)
  doc.font('Helvetica').fontSize(10).fillColor('#1f2937').text(text, {
    align: 'justify',
    lineGap: 2,
  })
  doc.moveDown(0.45)
}

function addImages(doc: PDFKit.PDFDocument, images: PrintableImage[], uploadsRoot: string) {
  for (const image of uniqueImages(images)) {
    const input = resolveImageInput(image.source, uploadsRoot)
    if (!input) continue

    try {
      const size = getQuestionImageSize(doc, input)
      const pageWidth = getPageContentWidth(doc)
      const imageX = doc.page.margins.left + Math.max(0, (pageWidth - size.width) / 2)
      ensureSpace(doc, size.height + 15)
      doc.image(input, imageX, doc.y, {
        width: size.width,
        height: size.height,
      })
      doc.y += size.height
      doc.moveDown(0.7)
    } catch {
      ensureSpace(doc, 18)
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b').text(`[Imagem indisponível: ${image.alt}]`)
      doc.moveDown(0.35)
    }
  }
}

function getOptionRowMetrics(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  images: PrintableImage[],
  uploadsRoot: string,
): OptionRowMetrics {
  const right = doc.page.width - doc.page.margins.right
  const labelWidth = 24
  const gap = 8
  const contentX = doc.page.margins.left + labelWidth + gap
  const contentWidth = right - contentX
  const maxImageWidth = 150
  const maxImageHeight = 86
  const imageGap = 6
  const resolvedImages = uniqueImages(images).map((image) => ({
    ...image,
    input: resolveImageInput(image.source, uploadsRoot),
  }))
  const displayText = resolvedImages.length > 0 && isOptionImagePlaceholderText(value, label) ? '' : cleanText(value)
  const textHeight = displayText
    ? doc.font('Helvetica').fontSize(9.5).heightOfString(displayText, { width: contentWidth, lineGap: 1.5 })
    : 0
  const imageHeight = resolvedImages.length > 0
    ? resolvedImages.length * maxImageHeight + (resolvedImages.length - 1) * imageGap
    : 0
  const rowHeight = Math.max(18, textHeight + (displayText && imageHeight ? 5 : 0) + imageHeight)

  return {
    labelWidth,
    contentX,
    contentWidth,
    maxImageWidth,
    maxImageHeight,
    imageGap,
    resolvedImages,
    displayText,
    textHeight,
    rowHeight,
  }
}

function measureOptionRowHeight(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  images: PrintableImage[],
  uploadsRoot: string,
) {
  return getOptionRowMetrics(doc, label, value, images, uploadsRoot).rowHeight + 6
}

function isCompactImageOptionRow(row: PreparedOptionRow) {
  return row.optionImages.length > 0 && (!cleanText(row.optionText) || isOptionImagePlaceholderText(row.optionText, row.option.label))
}

function shouldUseCompactOptionGrid(rows: PreparedOptionRow[]) {
  return rows.length >= 3 && rows.every(isCompactImageOptionRow)
}

function getCompactOptionCellMetrics(
  doc: PDFKit.PDFDocument,
  row: PreparedOptionRow,
  uploadsRoot: string,
  cellWidth: number,
) {
  const labelWidth = 24
  const gap = 8
  const contentWidth = cellWidth - labelWidth - gap
  const maxImageWidth = Math.min(150, contentWidth)
  const maxImageHeight = 86
  const imageGap = 4
  const resolvedImages = uniqueImages(row.optionImages).map((image) => ({
    ...image,
    input: resolveImageInput(image.source, uploadsRoot),
  }))
  const imageHeight = resolvedImages.length > 0
    ? resolvedImages.length * maxImageHeight + (resolvedImages.length - 1) * imageGap
    : 0
  const rowHeight = Math.max(18, imageHeight)

  return {
    labelWidth,
    gap,
    contentWidth,
    maxImageWidth,
    maxImageHeight,
    imageGap,
    resolvedImages,
    rowHeight,
  }
}

function measureCompactOptionGridHeight(doc: PDFKit.PDFDocument, rows: PreparedOptionRow[], uploadsRoot: string) {
  const columnGap = 14
  const rowGap = 6
  const cellWidth = (getPageContentWidth(doc) - columnGap) / 2
  let height = 0

  for (let index = 0; index < rows.length; index += 2) {
    const first = getCompactOptionCellMetrics(doc, rows[index], uploadsRoot, cellWidth).rowHeight
    const second = rows[index + 1] ? getCompactOptionCellMetrics(doc, rows[index + 1], uploadsRoot, cellWidth).rowHeight : 0
    height += Math.max(first, second)
    if (index + 2 < rows.length) height += rowGap
  }

  return height + 6
}

function addCompactOptionGrid(doc: PDFKit.PDFDocument, rows: PreparedOptionRow[], uploadsRoot: string) {
  const columnGap = 14
  const rowGap = 6
  const left = doc.page.margins.left
  const cellWidth = (getPageContentWidth(doc) - columnGap) / 2
  const gridHeight = measureCompactOptionGridHeight(doc, rows, uploadsRoot)

  ensureSpace(doc, gridHeight + 6)

  let rowY = doc.y
  for (let index = 0; index < rows.length; index += 2) {
    const pair = rows.slice(index, index + 2)
    const metrics = pair.map((row) => getCompactOptionCellMetrics(doc, row, uploadsRoot, cellWidth))
    const pairHeight = Math.max(...metrics.map((metric) => metric.rowHeight))

    pair.forEach((row, pairIndex) => {
      const metric = metrics[pairIndex]
      const cellX = left + pairIndex * (cellWidth + columnGap)
      const contentX = cellX + metric.labelWidth + metric.gap

      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111827').text(`${row.option.label})`, cellX, rowY, {
        width: metric.labelWidth,
      })

      let imageY = rowY
      for (const image of metric.resolvedImages) {
        try {
          if (!image.input) throw new Error('Image unavailable')
          doc.image(image.input, contentX, imageY, {
            fit: [metric.maxImageWidth, metric.maxImageHeight],
          })
        } catch {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b').text(`[Imagem indisponível: ${image.alt}]`, contentX, imageY, {
            width: metric.contentWidth,
          })
        }
        imageY += metric.maxImageHeight + metric.imageGap
      }
    })

    rowY += pairHeight + rowGap
  }

  doc.y = rowY
}

function addOptionRow(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  images: PrintableImage[],
  uploadsRoot: string,
) {
  const left = doc.page.margins.left
  const {
    labelWidth,
    contentX,
    contentWidth,
    maxImageWidth,
    maxImageHeight,
    imageGap,
    resolvedImages,
    displayText,
    textHeight,
    rowHeight,
  } = getOptionRowMetrics(doc, label, value, images, uploadsRoot)

  ensureSpace(doc, rowHeight + 10)

  const rowY = doc.y
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111827').text(`${label})`, left, rowY, {
    width: labelWidth,
  })

  if (displayText) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#1f2937').text(displayText, contentX, rowY, {
      width: contentWidth,
      lineGap: 1.5,
    })
  }

  let imageY = rowY + (displayText ? textHeight + 5 : 0)
  for (const image of resolvedImages) {
    try {
      if (!image.input) throw new Error('Image unavailable')
      doc.image(image.input, contentX, imageY, {
        fit: [maxImageWidth, maxImageHeight],
      })
    } catch {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b').text(`[Imagem indisponível: ${image.alt}]`, contentX, imageY, {
        width: contentWidth,
      })
    }
    imageY += maxImageHeight + imageGap
  }

  if (!displayText && resolvedImages.length === 0) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#1f2937').text('Alternativa sem texto', contentX, rowY, {
      width: contentWidth,
      lineGap: 1.5,
    })
  }

  doc.y = rowY + rowHeight + 6
}

function addQuestion(doc: PDFKit.PDFDocument, question: Question, index: number, uploadsRoot: string) {
  const statement = extractMarkdownImages(question.statement)
  const context = extractMarkdownImages(question.context)
  const statementImages = [...statement.images, ...getAttachmentImages(question, ['STATEMENT'])]
  const contextImages = [...context.images, ...getAttachmentImages(question, ['CONTEXT'])]
  const optionAttachments = getOptionAttachmentImages(question)
  const options = [...(question.options ?? [])].sort((first, second) => first.order - second.order)
  const optionRows = options.map((option, optionIndex) => {
    const optionBody = extractMarkdownImages(option.text)
    const optionImages = [
      ...optionBody.images,
      ...getImagesForOption(optionAttachments, option, optionIndex, options.length),
    ]

    return {
      option,
      optionText: optionBody.text,
      optionImages,
    }
  })
  const title = `${index + 1}. ${statement.text || cleanText(question.title) || 'Questão sem enunciado'}`
  const useCompactOptionGrid = shouldUseCompactOptionGrid(optionRows)
  const questionBlockHeight = [
    6,
    measureTitleHeight(doc, title),
    measureQuestionImagesHeight(doc, statementImages, uploadsRoot),
    measureTextHeight(doc, context.text),
    measureQuestionImagesHeight(doc, contextImages, uploadsRoot),
    useCompactOptionGrid
      ? measureCompactOptionGridHeight(doc, optionRows, uploadsRoot)
      : optionRows.reduce((total, row) => total + measureOptionRowHeight(doc, row.option.label, row.optionText, row.optionImages, uploadsRoot), 0),
    14,
  ].reduce((total, height) => total + height, 0)

  ensureBlockStartsOnSamePage(doc, questionBlockHeight)

  doc.moveDown(0.2)
  addTitle(doc, title)
  addImages(doc, statementImages, uploadsRoot)
  addText(doc, context.text)
  addImages(doc, contextImages, uploadsRoot)

  if (useCompactOptionGrid) {
    addCompactOptionGrid(doc, optionRows, uploadsRoot)
  } else {
    for (const row of optionRows) {
      addOptionRow(doc, row.option.label, row.optionText, row.optionImages, uploadsRoot)
    }
  }

  doc.moveDown(0.7)
}

function getEvaluationVersionId(evaluation: Evaluation) {
  const questionSignature = (evaluation.questionIds ?? []).join(',')
  const hash = createHash('sha1').update(`${evaluation.id}:${questionSignature}:${evaluation.questions}`).digest('hex').slice(0, 12)
  return `${evaluation.id}:v-${hash}`
}

async function createAnswerCardQrBuffer(input: EvaluationPdfInput) {
  const versionId = getEvaluationVersionId(input.evaluation)
  const payload = {
    examId: input.evaluation.id,
    versionId,
    answerCardId: `${input.evaluation.id}:${versionId}`,
    templateVersion: omrTemplateVersion,
    questionCount: input.questions.length,
  }

  return QRCode.toBuffer(JSON.stringify(payload), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 210,
  })
}

function getOmrGridLayout(totalQuestions: number) {
  const columns = Math.min(4, Math.max(1, Math.ceil(totalQuestions / 25)))
  const rowsPerColumn = Math.ceil(totalQuestions / columns)
  const availableHeight = omrCanonicalHeight - omrGridTop - omrGridBottomMargin
  const rowHeight = Math.min(48, Math.max(30, availableHeight / Math.max(rowsPerColumn, 1)))
  const questionLabelWidth = columns === 1 ? 48 : columns === 2 ? 42 : columns === 3 ? 36 : 32
  const questionLabelGap = columns === 1 ? 34 : columns === 2 ? 24 : columns === 3 ? 18 : 14
  const columnGap = columns === 1 ? 0 : columns === 2 ? 72 : columns === 3 ? 50 : 28
  const baseBubbleSpacing = columns === 1 ? 68 : columns === 2 ? 52 : columns === 3 ? 42 : 36
  const maxBubbleRadius = columns === 1 ? 22 : columns === 2 ? 19 : columns === 3 ? 16 : 14
  const bubbleRadius = Math.min(maxBubbleRadius, Math.max(13, Math.floor(rowHeight * 0.42)))
  const bubbleSpacing = Math.max(bubbleRadius * 2 + 8, baseBubbleSpacing)
  const optionBlockWidth = (omrOptions.length - 1) * bubbleSpacing + bubbleRadius * 2
  const columnWidth = questionLabelWidth + questionLabelGap + optionBlockWidth
  const gridWidth = columns * columnWidth + (columns - 1) * columnGap
  const gridLeft = (omrCanonicalWidth - gridWidth) / 2
  const firstBubbleOffset = questionLabelWidth + questionLabelGap + bubbleRadius
  const columnStep = columnWidth + columnGap

  return {
    columns,
    rowsPerColumn,
    rowHeight,
    columnWidth,
    columnStep,
    gridLeft,
    questionLabelWidth,
    firstBubbleOffset,
    bubbleSpacing,
    bubbleRadius,
  }
}

function addOmrAnswerCard(doc: PDFKit.PDFDocument, input: EvaluationPdfInput, qrBuffer: Buffer) {
  const totalQuestions = input.questions.length
  const availableHeight = doc.page.height - doc.y - doc.page.margins.bottom
  const maxWidthByHeight = Math.max(300, availableHeight * (omrCanonicalWidth / omrCanonicalHeight))
  const cardWidth = Math.min(getPageContentWidth(doc), maxWidthByHeight)
  const cardHeight = cardWidth * (omrCanonicalHeight / omrCanonicalWidth)

  if (availableHeight < cardHeight + 20) doc.addPage()

  const x = doc.page.margins.left + (getPageContentWidth(doc) - cardWidth) / 2
  const y = doc.y
  const sx = cardWidth / omrCanonicalWidth
  const sy = cardHeight / omrCanonicalHeight
  const px = (value: number) => x + value * sx
  const py = (value: number) => y + value * sy
  const sw = (value: number) => value * sx
  const sh = (value: number) => value * sy
  const sr = (value: number) => Math.min(sw(value), sh(value))

  doc.save()
  doc.roundedRect(x, y, cardWidth, cardHeight, 6).fillAndStroke('#ffffff', '#111827')

  const markerPositions = [
    [omrMarkerMargin, omrMarkerMargin],
    [omrCanonicalWidth - omrMarkerMargin - omrMarkerSize, omrMarkerMargin],
    [omrCanonicalWidth - omrMarkerMargin - omrMarkerSize, omrCanonicalHeight - omrMarkerMargin - omrMarkerSize],
    [omrMarkerMargin, omrCanonicalHeight - omrMarkerMargin - omrMarkerSize],
  ]
  doc.fillColor('#000000')
  for (const [mx, my] of markerPositions) {
    doc.rect(px(mx), py(my), sw(omrMarkerSize), sh(omrMarkerSize)).fill()
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('CARTAO RESPOSTA', px(120), py(72), { width: sw(560) })
  doc.font('Helvetica').fontSize(8).fillColor('#111827')
  doc.text(`Prova: ${cleanText(input.evaluation.title)}`, px(120), py(112), { width: sw(560), ellipsis: true })
  doc.text(`Turma: ${cleanText(input.classRoom?.name ?? 'Turma nao encontrada')}`, px(120), py(146), { width: sw(560), ellipsis: true })
  doc.text(`Questoes: ${totalQuestions}`, px(120), py(180), { width: sw(180) })
  doc.text(`Versao: ${getEvaluationVersionId(input.evaluation)}`, px(120), py(214), { width: sw(560), ellipsis: true })
  doc.image(qrBuffer, px(780), py(72), { width: sw(190), height: sh(190) })
  doc.font('Helvetica').fontSize(7).fillColor('#334155').text('Nao dobre, corte ou rasure este cartao.', px(120), py(270), { width: sw(860) })
  doc.moveTo(px(120), py(315)).lineTo(px(980), py(315)).strokeColor('#111827').lineWidth(0.8).stroke()

  if (totalQuestions === 0) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#991b1b').text('Cartao indisponivel: nenhuma questao vinculada.', px(120), py(390), { width: sw(820) })
    doc.restore()
    doc.y = y + cardHeight + 16
    return
  }

  const layout = getOmrGridLayout(totalQuestions)
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#111827')
  for (let column = 0; column < layout.columns; column += 1) {
    const columnX = layout.gridLeft + column * layout.columnStep
    const firstBubbleX = columnX + layout.firstBubbleOffset
    omrOptions.forEach((option, optionIndex) => {
      doc.text(option, px(firstBubbleX + optionIndex * layout.bubbleSpacing - 12), py(omrGridTop - 34), {
        width: sw(24),
        align: 'center',
      })
    })
  }

  for (let index = 0; index < totalQuestions; index += 1) {
    const questionNumber = index + 1
    const column = Math.floor(index / layout.rowsPerColumn)
    const row = index % layout.rowsPerColumn
    const columnX = layout.gridLeft + column * layout.columnStep
    const rowY = omrGridTop + row * layout.rowHeight
    const firstBubbleX = columnX + layout.firstBubbleOffset

    doc.font('Helvetica-Bold').fontSize(layout.rowHeight >= 34 ? 7.5 : 6.5).fillColor('#111827').text(String(questionNumber).padStart(2, '0'), px(columnX), py(rowY - 6), {
      width: sw(layout.questionLabelWidth),
      align: 'right',
    })

    omrOptions.forEach((_option, optionIndex) => {
      doc.circle(px(firstBubbleX + optionIndex * layout.bubbleSpacing), py(rowY), sr(layout.bubbleRadius)).lineWidth(1).strokeColor('#111827').stroke()
    })
  }

  doc.restore()
  doc.y = y + cardHeight + 16
}

function addAnswerCard(doc: PDFKit.PDFDocument, totalQuestions: number) {
  doc.addPage()
  addTitle(doc, 'Cartão de respostas')

  if (totalQuestions === 0) {
    addText(doc, 'Cartão indisponível: nenhuma questão vinculada.')
    return
  }

  const columns = 3
  const columnWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / columns
  const startX = doc.page.margins.left
  let y = doc.y + 4

  doc.font('Helvetica').fontSize(9).fillColor('#111827')
  for (let index = 0; index < totalQuestions; index += 1) {
    const column = index % columns
    if (index > 0 && column === 0) y += 18
    if (y > doc.page.height - doc.page.margins.bottom - 16) {
      doc.addPage()
      y = doc.page.margins.top
    }

    doc.text(`${index + 1}. A( ) B( ) C( ) D( ) E( )`, startX + column * columnWidth, y, {
      width: columnWidth - 8,
    })
  }
}

function addPageNumbers(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange()
  for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex)
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(
      `Página ${pageIndex + 1} de ${range.count}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom + 12,
      {
        align: 'center',
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      },
    )
  }
}

export async function writeEvaluationPdfFile(input: EvaluationPdfInput, filePath: string) {
  const answerCardQrBuffer = await createAnswerCardQrBuffer(input)
  const stream = createWriteStream(filePath)
  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
    info: {
      Title: cleanText(input.evaluation.title),
      Author: 'LiEnsina',
      Subject: 'Prova escolar',
    },
  })

  const finished = new Promise<void>((resolveFinished, rejectFinished) => {
    stream.on('finish', resolveFinished)
    stream.on('error', rejectFinished)
    doc.on('error', rejectFinished)
  })

  doc.pipe(stream)

  addOmrAnswerCard(doc, input, answerCardQrBuffer)
  doc.addPage()

  doc.font('Helvetica-Bold').fontSize(17).fillColor('#111827').text(cleanText(input.evaluation.title).toUpperCase(), {
    align: 'center',
  })
  doc.moveDown(0.6)
  doc.font('Helvetica').fontSize(10).fillColor('#111827')
  doc.text(`Aluno: ________________________________________________`)
  doc.text(`Data: ${formatDate(input.evaluation.scheduledAt)}`)
  doc.text(`Turma: ${cleanText(input.classRoom?.name ?? 'Turma não encontrada')}`)
  doc.text(`Disciplina: ${cleanText(input.evaluation.subject)}`)
  doc.moveDown(0.8)
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#111827').lineWidth(0.8).stroke()
  doc.moveDown(0.8)

  if (input.questions.length === 0) {
    addTitle(doc, 'Prova cadastrada sem questões vinculadas')
    addText(doc, 'Esta avaliação está registrada no sistema, mas não possui questões associadas ao banco para impressão.')
  } else {
    input.questions.forEach((question, index) => addQuestion(doc, question, index, input.uploadsRoot))
  }

  addPageNumbers(doc)
  doc.end()

  await finished
}
