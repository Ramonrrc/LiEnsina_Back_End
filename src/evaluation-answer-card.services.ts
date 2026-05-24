import type { ClassRoom, Evaluation, EvaluationAnswerCard, Student } from './liensina.types'

export const defaultOmrCardVersion = 'liensina-omr-v1'

type CreateId = (prefix: string) => string

export type AnswerCardCreationInput = {
  evaluation: Evaluation
  classRoom: ClassRoom
  students: Student[]
  teacherId: string
  now: string
  createId: CreateId
  startIndex?: number
}

export class EvaluationQrCodeService {
  buildPayload(card: EvaluationAnswerCard) {
    return {
      cartao_id: card.cardId,
      escola_id: card.schoolId,
      turma_id: card.classId,
      materia_id: card.subject,
      prova_id: card.evaluationId,
      aluno_id: card.studentId,
      aluno_nome: card.studentName,
      professor_id: card.teacherId,
      versao_cartao: defaultOmrCardVersion,
      templateVersion: defaultOmrCardVersion,
      answerCardId: card.cardId,
      examId: card.evaluationId,
      classId: card.classId,
      studentId: card.studentId,
    }
  }

  stringifyPayload(card: EvaluationAnswerCard) {
    return JSON.stringify(this.buildPayload(card)).replace(/[\u007f-\uffff]/g, (char) => {
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    })
  }

  extractPayload(value: unknown): Record<string, unknown> | null {
    if (!value) return null
    if (typeof value === 'string') {
      const direct = value.trim()
      if (!direct) return null
      try {
        const parsed = JSON.parse(direct) as unknown
        return this.extractPayload(parsed)
      } catch {
        return null
      }
    }
    if (typeof value !== 'object') return null

    const record = value as Record<string, unknown>
    const directKeys = ['cartao_id', 'answerCardId', 'prova_id', 'examId', 'aluno_id', 'studentId']
    if (directKeys.some((key) => key in record)) return record

    const candidates = [
      record.qrCode,
      record.parsed,
      record.qr,
      record.qr_payload,
      record.qrPayload,
      record.raw,
    ]

    for (const candidate of candidates) {
      const found = this.extractPayload(candidate)
      if (found) return found
    }

    return null
  }

  readPayloadString(payload: Record<string, unknown> | null, keys: string[]) {
    if (!payload) return ''
    for (const key of keys) {
      const value = payload[key]
      if (value != null) {
        const normalized = String(value).trim()
        if (normalized) return normalized
      }
    }
    return ''
  }

  extractCardId(value: unknown): string | null {
    if (!value) return null
    if (typeof value === 'string') {
      const direct = value.trim()
      if (!direct) return null
      try {
        const parsed = JSON.parse(direct) as Record<string, unknown>
        return this.extractCardId(parsed) ?? direct
      } catch {
        return direct
      }
    }
    if (typeof value !== 'object') return null

    const record = value as Record<string, unknown>
    const candidates = [
      record.answerCardId,
      record.cartao_id,
      record.cardId,
      record.qrCardId,
      record.qr_payload,
      record.qrPayload,
      record.qrCode,
      record.parsed,
      record.qr,
    ]

    for (const candidate of candidates) {
      const found: string | null = this.extractCardId(candidate)
      if (found) return found
    }

    return null
  }
}

export class EvaluationAnswerCardCreationService {
  private readonly qrCodeService = new EvaluationQrCodeService()

  createCards(input: AnswerCardCreationInput) {
    return input.students.map((student, index) => {
      const sequence = String(index + 1 + (input.startIndex ?? 0)).padStart(4, '0')
      const cardId = `CRT-${input.evaluation.id.slice(0, 8).toUpperCase()}-${sequence}`
      const card: EvaluationAnswerCard = {
        id: input.createId('answer-card'),
        cardId,
        schoolId: input.classRoom.schoolId,
        classId: input.classRoom.id,
        subject: input.evaluation.subject,
        evaluationId: input.evaluation.id,
        studentId: student.id,
        studentName: student.name,
        teacherId: input.teacherId,
        qrPayload: '',
        status: 'GENERATED',
        createdAt: input.now,
        updatedAt: input.now,
      }
      card.qrPayload = this.qrCodeService.stringifyPayload(card)
      return card
    })
  }
}
