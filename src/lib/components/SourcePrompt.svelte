<script lang="ts">
  let {
    loading,
    error,
    gtfsLoaded = false,
    liveLoaded = false,
    onFileSelect,
    onUrlSubmit,
    onLiveDbSelect,
    onClose,
  }: {
    loading: boolean;
    error: string | null;
    gtfsLoaded?: boolean;
    liveLoaded?: boolean;
    onFileSelect: (blob: Blob) => void;
    onUrlSubmit: (url: string) => void;
    onLiveDbSelect: (blob: Blob) => void;
    onClose: () => void;
  } = $props();

  let tab = $state<'file' | 'url' | 'live'>('file');
  let urlValue = $state('');
  let dragging = $state(false);
  let fileError = $state<string | null>(null);

  function handleFileInput(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) validateAndLoad(file);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) {
      if (tab === 'live') validateAndLoadDb(file);
      else validateAndLoad(file);
    }
  }

  function validateAndLoad(file: File) {
    if (!file.name.endsWith('.zip')) { fileError = 'Please upload a GTFS .zip file'; return; }
    fileError = null;
    onFileSelect(file);
  }

  function handleLiveInput(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) validateAndLoadDb(file);
  }

  function validateAndLoadDb(file: File) {
    if (!file.name.endsWith('.db') && !file.name.endsWith('.sqlite') && !file.name.endsWith('.sqlite3')) {
      fileError = 'Please upload a SQLite .db file';
      return;
    }
    fileError = null;
    onLiveDbSelect(file);
  }

  function handleUrlSubmit(e: Event) {
    e.preventDefault();
    if (urlValue.trim()) onUrlSubmit(urlValue.trim());
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm"
  onclick={handleBackdropClick}
  role="dialog"
  aria-modal="true"
>
  <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">

    <!-- Header -->
    <div class="flex items-start justify-between mb-5">
      <div>
        <h2 class="text-lg font-semibold text-white">Load data</h2>
        <p class="text-sm text-slate-400 mt-0.5">Upload a GTFS feed and/or a live vehicle database.</p>
      </div>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-700 hover:text-slate-200 transition-colors ml-4 shrink-0 mt-0.5"
        onclick={onClose}
        aria-label="Close"
      >
        <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <!-- Loaded status -->
    {#if gtfsLoaded || liveLoaded}
      <div class="mb-4 flex gap-2">
        {#if gtfsLoaded}
          <span class="flex items-center gap-1.5 rounded-full bg-indigo-950/60 border border-indigo-700/50 px-2.5 py-1 text-[11px] text-indigo-300">
            <svg class="h-3 w-3 text-indigo-400" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            GTFS loaded
          </span>
        {/if}
        {#if liveLoaded}
          <span class="flex items-center gap-1.5 rounded-full bg-emerald-950/60 border border-emerald-700/50 px-2.5 py-1 text-[11px] text-emerald-300">
            <svg class="h-3 w-3 text-emerald-400" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Live data loaded
          </span>
        {/if}
      </div>
    {/if}

    <!-- Tabs -->
    <div class="mb-5 flex gap-1 rounded-lg bg-slate-800 p-1">
      {#each ([['file', 'GTFS file'], ['url', 'GTFS URL'], ['live', 'Live data']] as const) as [t, label]}
        <button
          class="flex-1 rounded-md py-1.5 text-xs font-medium transition-colors
                 {tab === t ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}"
          onclick={() => { tab = t; fileError = null; }}
        >{label}</button>
      {/each}
    </div>

    {#if tab === 'file'}
      <label
        class="flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors
               {dragging ? 'border-indigo-400 bg-indigo-950/30' : 'border-slate-600 hover:border-slate-500'}"
        ondragover={(e) => { e.preventDefault(); dragging = true; }}
        ondragleave={() => { dragging = false; }}
        ondrop={handleDrop}
      >
        <svg class="h-8 w-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <div>
          <span class="text-sm font-medium text-slate-300">{gtfsLoaded ? 'Replace GTFS feed' : 'Drop your GTFS .zip here'}</span>
          <span class="block text-xs text-slate-500 mt-1">or click to browse</span>
        </div>
        <input type="file" accept=".zip" class="sr-only" onchange={handleFileInput} />
      </label>

    {:else if tab === 'url'}
      <form onsubmit={handleUrlSubmit} class="flex flex-col gap-3">
        <input
          type="url"
          bind:value={urlValue}
          placeholder="https://agency.com/gtfs.zip"
          class="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-400"
        />
        <button
          type="submit"
          disabled={loading || !urlValue.trim()}
          class="rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white transition-colors
                 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Loading…' : gtfsLoaded ? 'Replace GTFS' : 'Load'}
        </button>
      </form>

    {:else}
      <label
        class="flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors
               {dragging ? 'border-emerald-400 bg-emerald-950/30' : 'border-slate-600 hover:border-slate-500'}"
        ondragover={(e) => { e.preventDefault(); dragging = true; }}
        ondragleave={() => { dragging = false; }}
        ondrop={handleDrop}
      >
        <svg class="h-8 w-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694 4.125-8.25 4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
        </svg>
        <div>
          <span class="text-sm font-medium text-slate-300">{liveLoaded ? 'Replace live database' : 'Drop a SQLite .db file here'}</span>
          <span class="block text-xs text-slate-500 mt-1">vehicle_positions table · or click to browse</span>
        </div>
        <input type="file" accept=".db,.sqlite,.sqlite3" class="sr-only" onchange={handleLiveInput} />
      </label>
    {/if}

    {#if fileError}
      <p class="mt-2 text-xs text-red-400">{fileError}</p>
    {/if}

    {#if error}
      <p class="mt-4 rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-400 border border-red-900">{error}</p>
    {/if}

    {#if loading}
      <div class="mt-4 flex items-center gap-2 text-xs text-slate-400">
        <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        {tab === 'live' ? 'Loading live data…' : 'Parsing GTFS data…'}
      </div>
    {/if}

    <!-- Done button — visible once at least one source is loaded -->
    {#if gtfsLoaded || liveLoaded}
      <button
        class="mt-5 w-full rounded-lg bg-slate-700 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600 transition-colors"
        onclick={onClose}
      >Done</button>
    {/if}
  </div>
</div>
