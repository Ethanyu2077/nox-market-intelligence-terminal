import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AlertRule, MarketProject, ProjectMarket, ProjectMonitoringPreferences } from '../shared/types.ts';

interface StoreData { watchlist: string[]; alerts: AlertRule[]; projects: MarketProject[]; selectedProjectId: string | null }
type ProjectInput = Pick<MarketProject, 'name' | 'tokenSymbol' | 'contractAddress' | 'identitySource' | 'identityNetwork' | 'markets' | 'primaryMarketId'> & { monitoring?: Partial<ProjectMonitoringPreferences> };
const initial: StoreData = { watchlist: [], alerts: [], projects: [], selectedProjectId: null };

export class FileStore {
  private file: string;
  private data: StoreData = structuredClone(initial);
  private writeQueue = Promise.resolve();

  constructor(directory: string) { this.file = path.join(directory, 'preferences.json'); }

  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoreData>;
      this.data = { ...structuredClone(initial), ...saved, projects: saved.projects ?? [], selectedProjectId: saved.selectedProjectId ?? null };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.persist(); }
  }

  getWatchlist() { return [...this.data.watchlist]; }
  async setWatchlist(symbols: string[]) {
    this.data.watchlist = [...new Set(symbols.map((s) => s.toUpperCase()))];
    await this.persist();
    return this.getWatchlist();
  }
  getAlerts() { return [...this.data.alerts]; }
  async addAlert(rule: Omit<AlertRule, 'id' | 'createdAt'>) {
    const alert = { ...rule, id: crypto.randomUUID(), createdAt: Date.now() };
    this.data.alerts.push(alert);
    await this.persist();
    return alert;
  }
  getProjects(includeArchived = false) {
    return this.data.projects.filter((project) => includeArchived || !project.archived).sort((a, b) => a.order - b.order).map((project) => structuredClone(project));
  }
  getSelectedProjectId() { return this.data.selectedProjectId; }
  async setSelectedProject(id: string | null) {
    if (id && !this.data.projects.some((project) => project.id === id && !project.archived)) throw new Error('Selected project is unavailable');
    this.data.selectedProjectId = id;
    await this.persist();
    return id;
  }
  async addProject(input: ProjectInput) {
    this.assertMarkets(input.markets, input.primaryMarketId);
    const now = Date.now();
    const project: MarketProject = {
      ...input,
      name: input.name.trim(), tokenSymbol: input.tokenSymbol.toUpperCase(), contractAddress: input.contractAddress || null,
      identityNetwork: input.identityNetwork || null, markets: structuredClone(input.markets),
      monitoring: { defaultInterval: input.monitoring?.defaultInterval ?? '5m', streamingEnabled: input.monitoring?.streamingEnabled ?? true, collectionMode: input.monitoring?.collectionMode ?? 'standard' },
      id: crypto.randomUUID(), archived: false, order: this.data.projects.length, createdAt: now, updatedAt: now
    };
    this.data.projects.push(project);
    if (!this.data.selectedProjectId) this.data.selectedProjectId = project.id;
    await this.persist();
    return structuredClone(project);
  }
  async updateProject(id: string, update: Partial<ProjectInput> & { archived?: boolean }) {
    const project = this.data.projects.find((item) => item.id === id);
    if (!project) throw new Error('Project not found');
    if (update.markets || update.primaryMarketId) this.assertMarkets(update.markets ?? project.markets, update.primaryMarketId ?? project.primaryMarketId);
    Object.assign(project, {
      ...update,
      name: update.name?.trim() ?? project.name,
      tokenSymbol: update.tokenSymbol?.toUpperCase() ?? project.tokenSymbol,
      contractAddress: update.contractAddress === undefined ? project.contractAddress : update.contractAddress || null,
      identityNetwork: update.identityNetwork === undefined ? project.identityNetwork : update.identityNetwork || null,
      markets: update.markets ? structuredClone(update.markets) : project.markets,
      monitoring: update.monitoring ? { ...project.monitoring, ...update.monitoring } : project.monitoring,
      updatedAt: Date.now()
    });
    if (project.archived && this.data.selectedProjectId === id) this.data.selectedProjectId = this.data.projects.find((item) => !item.archived && item.id !== id)?.id ?? null;
    await this.persist();
    return structuredClone(project);
  }
  async removeProject(id: string) {
    const index = this.data.projects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error('Project not found');
    this.data.projects.splice(index, 1);
    this.data.projects.sort((a, b) => a.order - b.order).forEach((project, order) => { project.order = order; });
    if (this.data.selectedProjectId === id) this.data.selectedProjectId = this.data.projects.find((project) => !project.archived)?.id ?? null;
    await this.persist();
  }
  async reorderProjects(ids: string[]) {
    const known = new Set(this.data.projects.map((project) => project.id));
    if (ids.length !== known.size || new Set(ids).size !== known.size || ids.some((id) => !known.has(id))) throw new Error('Reorder list must include every project exactly once');
    const order = new Map(ids.map((id, index) => [id, index]));
    this.data.projects.forEach((project) => { project.order = order.get(project.id)!; project.updatedAt = Date.now(); });
    await this.persist();
    return this.getProjects(true);
  }
  private assertMarkets(markets: ProjectMarket[], primaryMarketId: string) {
    if (!markets.length) throw new Error('Select at least one market');
    if (!markets.some((market) => market.id === primaryMarketId && market.marketType === 'perpetual' && market.quote === 'USDT')) throw new Error('Primary market must be a selected USDT perpetual');
    if (!markets.some((market) => market.marketType === 'perpetual')) throw new Error('Phase 1 requires at least one USDT perpetual market');
  }
  private persist() {
    const serialized = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => { await writeFile(`${this.file}.tmp`, serialized, { mode: 0o600 }); await rename(`${this.file}.tmp`, this.file); });
    return this.writeQueue;
  }
}
