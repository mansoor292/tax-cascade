import { useState } from 'react'
import { NavLink, useLocation, useParams } from 'react-router-dom'
import {
  Building2,
  Calculator,
  Key,
  GitBranch,
  TableProperties,
  Clock,
  Plus,
  FlaskConical,
  LayoutDashboard,
  ChevronDown,
  Wrench,
  Bot,
  CalendarClock,
  Network,
  Users,
  BadgeDollarSign,
  ShieldCheck,
  Settings2,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import { useEntities, type Entity } from '@/hooks/use-entities'
import { Skeleton } from '@/components/ui/skeleton'
import { maskTaxId } from '@/lib/mask'
import { FORM_TYPE_LABEL } from '@/lib/labels'

const tools = [
  { to: '/app/compute', label: 'Quick Compute', icon: Calculator },
  { to: '/app/cascade', label: 'Cascade', icon: GitBranch },
  { to: '/app/extensions', label: 'Extensions', icon: Clock },
  { to: '/app/tax-tables', label: 'Tax Tables', icon: TableProperties },
  { to: '/app/connect-claude', label: 'Connect Claude', icon: Bot },
]

function EntityItem({ entity }: { entity: Entity }) {
  const params = useParams()
  const isActive = params.id === entity.id

  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<NavLink to={`/app/entities/${entity.id}`} />} isActive={isActive} className="h-auto py-2">
        <Building2 className="shrink-0" />
        <div className="flex flex-col gap-0.5 leading-none min-w-0">
          <span className="truncate font-medium">{entity.name}</span>
          <span className="text-xs text-muted-foreground">
            {FORM_TYPE_LABEL[entity.form_type] || entity.form_type}
            {entity.ein ? ` · ${maskTaxId(entity.ein)}` : ''}
          </span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

const practiceNav = [
  { to: '/app/practice', label: 'Clients', icon: Users, end: true },
  { to: '/app/practice/opportunities', label: 'Opportunities', icon: BadgeDollarSign },
  { to: '/app/practice/deadlines', label: 'Deadlines', icon: CalendarClock },
  { to: '/app/practice/taxnow', label: 'TaxNow', icon: ShieldCheck },
  { to: '/app/practice/settings', label: 'Practice settings', icon: Settings2 },
]

/**
 * Two workspaces under one login (2026-10-24): "My returns" (the owner's own
 * entities: Dashboard, Group, Entities) and "Practice" (a preparer's clients).
 * The switch keeps them apart; practice clients never appear in the owner's
 * entity list.
 */
function WorkspaceSwitch({ practice }: { practice: boolean }) {
  const base = 'flex-1 rounded-md px-2 py-1 text-xs font-medium text-center transition-colors'
  return (
    <div className="mx-3 mb-1 flex gap-0.5 rounded-lg bg-muted p-0.5" role="group" aria-label="Workspace">
      <NavLink to="/app" className={`${base} ${!practice ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-current={!practice ? 'page' : undefined}>My returns</NavLink>
      <NavLink to="/app/practice" className={`${base} ${practice ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-current={practice ? 'page' : undefined}>Practice</NavLink>
    </div>
  )
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const inPractice = pathname.startsWith('/app/practice')
  if (inPractice) return <PracticeSidebar />
  return <OwnerSidebar />
}

function PracticeSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <NavLink to="/app/practice" className="flex items-center gap-2">
          <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
            <Calculator className="w-3.5 h-3.5 text-primary-foreground" />
          </div>
          <span className="font-semibold text-lg">Catipult</span>
        </NavLink>
      </SidebarHeader>
      <WorkspaceSwitch practice />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {practiceNav.map(l => (
                <SidebarMenuItem key={l.to}>
                  <SidebarMenuButton render={<NavLink to={l.to} end={l.end} />}>
                    <l.icon className="shrink-0" />
                    <span>{l.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}

function OwnerSidebar() {
  const { entities, loading } = useEntities()
  const [toolsOpen, setToolsOpen] = useState(false)

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <NavLink to="/app" className="flex items-center gap-2">
          <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
            <Calculator className="w-3.5 h-3.5 text-primary-foreground" />
          </div>
          <span className="font-semibold text-lg">Catipult</span>
        </NavLink>
      </SidebarHeader>
      <WorkspaceSwitch practice={false} />

      <SidebarContent>
        {/* Main nav */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<NavLink to="/app" end />}>
                  <LayoutDashboard className="shrink-0" />
                  <span>Dashboard</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<NavLink to="/app/calendar" />}>
                  <CalendarClock className="shrink-0" />
                  <span>Calendar</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<NavLink to="/app/group" />}>
                  <Network className="shrink-0" />
                  <span>Group</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<NavLink to="/app/scenarios" />}>
                  <FlaskConical className="shrink-0" />
                  <span>Scenarios</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Entities */}
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between">
            <span>Entities</span>
            <NavLink
              to="/app/entities?new=1"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </NavLink>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <div className="px-2 py-2">
                      <Skeleton className="h-4 w-full mb-1" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </SidebarMenuItem>
                ))
              ) : entities.length === 0 ? (
                <SidebarMenuItem>
                  <NavLink to="/app/entities?new=1">
                    <SidebarMenuButton className="text-muted-foreground">
                      <Plus className="shrink-0" />
                      <span>Create your first entity</span>
                    </SidebarMenuButton>
                  </NavLink>
                </SidebarMenuItem>
              ) : (
                entities.map(entity => (
                  <EntityItem key={entity.id} entity={entity} />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Tools — collapsible */}
        <SidebarGroup>
          <SidebarGroupLabel
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setToolsOpen(!toolsOpen)}
          >
            <span className="flex items-center gap-1.5">
              <Wrench className="w-3 h-3" />
              Tools
            </span>
            <ChevronDown className={`w-3 h-3 transition-transform ${toolsOpen ? '' : '-rotate-90'}`} />
          </SidebarGroupLabel>
          {toolsOpen && (
            <SidebarGroupContent>
              <SidebarMenu>
                {tools.map(link => (
                  <SidebarMenuItem key={link.to}>
                    <SidebarMenuButton render={<NavLink to={link.to} />}>
                      <link.icon className="shrink-0" />
                      <span>{link.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<NavLink to="/app/settings" />}>
              <Key className="shrink-0" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
