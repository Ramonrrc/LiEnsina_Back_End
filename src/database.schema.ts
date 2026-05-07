import type { DatabaseShape } from './liensina.types'

export const databaseCollections: Array<keyof DatabaseShape> = [
  'users',
  'refreshSessions',
  'roles',
  'schools',
  'teachers',
  'guardians',
  'students',
  'classes',
  'evaluations',
  'curriculumBases',
  'curriculumSkills',
  'assessmentPrograms',
  'assessmentMatrices',
  'assessmentDescriptors',
  'questions',
  'questionImportPlans',
  'calendarEvents',
  'mealFoods',
  'mealManagements',
  'auditEvents',
]

export function createEmptyDatabase(): DatabaseShape {
  return {
    users: [],
    refreshSessions: [],
    roles: [],
    schools: [],
    teachers: [],
    guardians: [],
    students: [],
    classes: [],
    evaluations: [],
    curriculumBases: [],
    curriculumSkills: [],
    assessmentPrograms: [],
    assessmentMatrices: [],
    assessmentDescriptors: [],
    questions: [],
    questionImportPlans: [],
    calendarEvents: [],
    mealFoods: [],
    mealManagements: [],
    auditEvents: [],
  }
}
