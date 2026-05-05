<script lang="ts">
  let {
    loading,
    error,
    onFileSelect,
    onUrlSubmit,
  }: {
    loading: boolean;
    error: string | null;
    onFileSelect: (blob: Blob) => void;
    onUrlSubmit: (url: string) => void;
  } = $props();

  let tab = $state<'file' | 'url'>('file');
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
    if (file) validateAndLoad(file);
  }

  function validateAndLoad(file: File) {
    if (!file.name.endsWith('.zip')) {
      fileError = 'Please upload a GTFS .zip file';
      return;
    }
    fileError = null;
    onFileSelect(file);
  }

  function handleUrlSubmit(e: Event) {
    e.preventDefault();
    if (urlValue.trim()) onUrlSubmit(urlValue.trim());
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
  <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
    <h2 class="mb-1 text-lg font-semibold text-white">Load GTFS feed</h2>
    <p class="mb-5 text-sm text-slate-400">Upload a GTFS .zip file or provide a direct URL.</p>

    <!-- Tabs -->
    <div class="mb-5 flex gap-1 rounded-lg bg-slate-800 p-1">
      {#each (['file', 'url'] as const) as t}
        <button
          class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors
                 {tab === t ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}"
          onclick={() => { tab = t; fileError = null; }}
        >
          {t === 'file' ? 'Upload file' : 'From URL'}
        </button>
      {/each}
    </div>

    {#if tab === 'file'}
      <!-- Drop zone -->
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
          <span class="text-sm font-medium text-slate-300">Drop your GTFS .zip here</span>
          <span class="block text-xs text-slate-500 mt-1">or click to browse</span>
        </div>
        <input type="file" accept=".zip" class="sr-only" onchange={handleFileInput} />
      </label>
      {#if fileError}
        <p class="mt-2 text-xs text-red-400">{fileError}</p>
      {/if}

    {:else}
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
          {loading ? 'Loading…' : 'Load'}
        </button>
      </form>
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
        Parsing GTFS data…
      </div>
    {/if}
  </div>
</div>