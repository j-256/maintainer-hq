import { createApplication } from './app'
import { resolveProductionPrincipal } from './auth'

export default createApplication(resolveProductionPrincipal)
export { WorkspaceEvents } from './workspace-events'
