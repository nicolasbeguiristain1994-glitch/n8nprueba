// Legacy entry points share the same validated onboarding implementation.
import { onboardCoexistenceUseCase } from './use-cases/onboard-coexistence.use-case'
export type { OnboardingResult } from './use-cases/onboard-coexistence.use-case'
export const startCoexistenceOnboarding = onboardCoexistenceUseCase.execute.bind(onboardCoexistenceUseCase)
export const verifyOTPAndActivate = onboardCoexistenceUseCase.verifyOTPAndActivate.bind(onboardCoexistenceUseCase)
