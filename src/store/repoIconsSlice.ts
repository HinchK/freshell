import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { api } from '@/lib/api'
import { pathBasename } from '@/lib/repo-icon'

export type RepoIconEntry = {
  status: 'loading' | 'ready' | 'error'
  repoRoot?: string
  checkoutRoot?: string
  repoName?: string
  hasIcon?: boolean
}

export type RepoIconsState = {
  byCwd: Record<string, RepoIconEntry>
}

type RepoIconMetaResponse = {
  repoRoot: string
  checkoutRoot: string
  repoName: string
  hasIcon: boolean
}

const initialState: RepoIconsState = { byCwd: {} }

/**
 * Probe the repo-icon meta endpoint once per distinct cwd. Rejections
 * (including a 404 from the Node dev server, which has no such endpoint)
 * are remembered as "no icon" so the letter avatar renders without re-probing.
 */
export const fetchRepoIconMeta = createAsyncThunk(
  'repoIcons/fetchMeta',
  async (cwd: string) =>
    api.get<RepoIconMetaResponse>(`/api/repo-icon/meta?cwd=${encodeURIComponent(cwd)}`),
  {
    condition: (cwd, { getState }) => {
      const state = getState() as { repoIcons?: RepoIconsState }
      return !state.repoIcons?.byCwd[cwd]
    },
  },
)

const repoIconsSlice = createSlice({
  name: 'repoIcons',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchRepoIconMeta.pending, (state, action) => {
        state.byCwd[action.meta.arg] = { status: 'loading' }
      })
      .addCase(fetchRepoIconMeta.fulfilled, (state, action) => {
        state.byCwd[action.meta.arg] = {
          status: 'ready',
          repoRoot: action.payload.repoRoot,
          checkoutRoot: action.payload.checkoutRoot,
          repoName: action.payload.repoName,
          hasIcon: action.payload.hasIcon,
        }
      })
      .addCase(fetchRepoIconMeta.rejected, (state, action) => {
        state.byCwd[action.meta.arg] = {
          status: 'error',
          hasIcon: false,
          repoName: pathBasename(action.meta.arg),
        }
      })
  },
})

export default repoIconsSlice.reducer
