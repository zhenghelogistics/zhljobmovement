import axios from 'axios'
import { supabase } from './lib/supabase'

const api = axios.create({ baseURL: '/api' })

// Attach the auth token to every request automatically
api.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`
  }
  return config
})

export const getJobs = (params) => api.get('/jobs', { params })
export const createJob = (data) => api.post('/jobs', data)
export const getJob = (id) => api.get(`/jobs/${id}`)
export const updateJob = (id, data) => api.put(`/jobs/${id}`, data)
export const deleteJob = (id) => api.delete(`/jobs/${id}`)

export const addCostLine = (jobId, data) => api.post(`/jobs/${jobId}/costs`, data)
export const updateCostLine = (jobId, lid, data) => api.put(`/jobs/${jobId}/costs/${lid}`, data)
export const deleteCostLine = (jobId, lid) => api.delete(`/jobs/${jobId}/costs/${lid}`)

export const addBillingLine = (jobId, data) => api.post(`/jobs/${jobId}/billing`, data)
export const updateBillingLine = (jobId, lid, data) => api.put(`/jobs/${jobId}/billing/${lid}`, data)
export const deleteBillingLine = (jobId, lid) => api.delete(`/jobs/${jobId}/billing/${lid}`)

export const addSplitEntity = (jobId, data) => api.post(`/jobs/${jobId}/split-entities`, data)
export const updateSplitEntity = (jobId, eid, data) => api.put(`/jobs/${jobId}/split-entities/${eid}`, data)
export const deleteSplitEntity = (jobId, eid) => api.delete(`/jobs/${jobId}/split-entities/${eid}`)
export const setBillingLineSplits = (jobId, lid, splits) => api.put(`/jobs/${jobId}/billing/${lid}/splits`, { splits })
export const setCostLineSplits = (jobId, lid, splits) => api.put(`/jobs/${jobId}/costs/${lid}/splits`, { splits })

export const uploadDocument = (jobId, file, doc_type) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('doc_type', doc_type)
  return api.post(`/jobs/${jobId}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
export const deleteDocument = (jobId, did) => api.delete(`/jobs/${jobId}/documents/${did}`)

export const parseEmail = (text) => api.post('/parse-email', { text })

export const parseEmailFile = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/parse-email-file', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

export const parseInvoice = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/parse-invoice', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

export const parseDO = (file, text) => {
  if (text) return api.post('/parse-do', { text })
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/parse-do', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

export const getDashboard = () => api.get('/dashboard')

export const getProfile = () => api.get('/profile')
export const updateProfile = (data) => api.put('/profile', data)

export const getFxRates = () => api.get('/fx-rates')
export const updateFxRates = (rates) => api.put('/fx-rates', { rates })

export const getCustomers = (search) => api.get('/customers', { params: search ? { search } : {} })
export const getStaff = () => api.get('/staff')

export const getCompanyStats = (params) => api.get('/stats/company', { params })
export const getCompanyList = () => api.get('/stats/companies')

export const getLeads = (params) => api.get('/leads', { params })
export const getNewLeadsCount = (since) => api.get('/leads/new-count', { params: since ? { since } : {} })
export const createLead = (data) => api.post('/leads', data)
export const updateLead = (id, data) => api.put(`/leads/${id}`, data)
export const deleteLead = (id) => api.delete(`/leads/${id}`)
export const getLeadStats = () => api.get('/leads/stats')
export const claimLead = (id) => api.put(`/leads/${id}/claim`)
export const generateEmail = (id, data) => api.post(`/leads/${id}/generate-email`, data)
export const convertLeadToJob = (id, mode) => api.post(`/leads/${id}/convert-to-job`, { mode })

export const unlockFxRate = (currency) => api.put(`/fx-rates/${currency}/unlock`)

export const linkInventoryMovement = (jobId) => api.post(`/jobs/${jobId}/inventory-link`)
export const voidInventoryMovement = (jobId) => api.put(`/jobs/${jobId}/inventory-void`)
export const syncStockLines = (jobId) => api.post(`/jobs/${jobId}/inventory-sync-lines`)

export const parsePackingList = (file, text) => {
  if (text) return api.post('/parse-packing-list', { text })
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/parse-packing-list', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

// Paperwork attached to an enquiry — sent by the customer via the website, or added
// by staff from an email.
export const getLeadDocuments = (id) => api.get(`/leads/${id}/documents`)
export const uploadLeadDocument = (id, file, doc_type = 'Other') => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('doc_type', doc_type)
  return api.post(`/leads/${id}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
export const deleteLeadDocument = (id, did) => api.delete(`/leads/${id}/documents/${did}`)

// Monthly BD report. The figures and the commentary are fetched separately so the deck
// still builds from real data if the AI call fails.
export const getMonthlyReport = (month) => api.get('/reports/monthly', { params: month ? { month } : {} })
export const getMonthlyNarrative = (report) => api.post('/reports/monthly/narrative', { report })

export const getMarketingContacts = () => api.get('/marketing-contacts')
export const deleteMarketingContact = (id) => api.delete(`/marketing-contacts/${id}`)

// Vendor rate cards — reference sheet of negotiated partner rates. Cards come back
// with their `lines` nested, so the picker needs one request, not one per card.
export const getRateCards = (params) => api.get('/rate-cards', { params: params || {} })
export const createRateCard = (data) => api.post('/rate-cards', data)
export const updateRateCard = (id, data) => api.put(`/rate-cards/${id}`, data)
export const deleteRateCard = (id) => api.delete(`/rate-cards/${id}`)
export const addRateLine = (cardId, data) => api.post(`/rate-cards/${cardId}/lines`, data)
export const updateRateLine = (cardId, lid, data) => api.put(`/rate-cards/${cardId}/lines/${lid}`, data)
export const deleteRateLine = (cardId, lid) => api.delete(`/rate-cards/${cardId}/lines/${lid}`)
// Prices a card against a job server-side so the rate maths has a single implementation.
export const previewRates = (jobId, card_id, qtys) => api.post(`/jobs/${jobId}/rate-preview`, { card_id, qtys })
// Reads a vendor's rate-card PDF into draft card + line data for review before saving.
export const parseRateCard = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/parse-rate-card', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

// If a request comes back unauthorized (expired/invalid session), the token
// is no longer valid — sign out of Supabase and force a reload back to the
// login gate rather than letting every subsequent request silently 401.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      supabase.auth.signOut().finally(() => {
        window.location.href = '/'
      })
    }
    return Promise.reject(error)
  }
)

export default api
