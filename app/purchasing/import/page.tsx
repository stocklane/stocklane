'use client';

import { Suspense, useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import PurchaseOrderForm from '../../../components/PurchaseOrderForm';
import { authenticatedFetch } from '@/lib/api-client';

interface FileGroup {
  id: string;
  name: string;
  files: File[];
}

interface ExtractedData {
  supplier: {
    name?: string;
    address?: string;
    email?: string;
    phone?: string;
    vatNumber?: string;
  };
  purchaseOrder: {
    invoiceNumber?: string;
    invoiceDate?: string;
    originalCurrency?: string;
    paymentTerms?: string;
  };
  poLines: Array<{
    description: string;
    supplierSku?: string;
    quantity: number;
    unitCostExVAT: number;
    lineTotalExVAT: number;
    rrp?: number;
  }>;
  totals: {
    subtotal?: number;
    extras?: number;
    vat?: number;
    total?: number;
  };
  notes?: string;
}

interface DuplicateMatch {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  supplierName: string;
  matchScore: number;
  matchReasons: string[];
  lineCount: number;
  createdAt: string;
}

interface GroupResult {
  group: FileGroup;
  status: 'pending' | 'processing' | 'extracted' | 'approved' | 'success' | 'cancelled' | 'error';
  extractedData?: ExtractedData;
  error?: string;
  duplicates?: DuplicateMatch[];
  duplicatesChecked?: boolean;
}

function ImportPageContent() {
  const searchParams = useSearchParams();
  const initialModeParam = searchParams.get('mode');
  const initialMode = (initialModeParam === 'manual' ? 'manual' : 'import') as 'import' | 'manual';

  const [mode, setMode] = useState<'import' | 'manual'>(initialMode);
  const [fileGroups, setFileGroups] = useState<FileGroup[]>([]);
  const [groupResults, setGroupResults] = useState<GroupResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedFile, setDraggedFile] = useState<{ groupId: string; fileIndex: number } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [editedData, setEditedData] = useState<{ [key: number]: ExtractedData }>({});
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [dismissedDuplicates, setDismissedDuplicates] = useState<Set<string>>(new Set());
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualFormKey, setManualFormKey] = useState(0);
  const router = useRouter();

  const navigateToView = () => {
    router.push('/purchasing/view');
  };

  const createNewGroup = (files: File[]) => {
    const newGroup: FileGroup = {
      id: crypto.randomUUID(),
      name: `Group ${fileGroups.length + 1}`,
      files: files,
    };
    setFileGroups(prev => [...prev, newGroup]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFiles = Array.from(e.target.files);
      // Create individual groups for each file
      setFileGroups(prev => {
        const newGroups = selectedFiles.map((file, index) => ({
          id: crypto.randomUUID(),
          name: `Group ${prev.length + index + 1}`,
          files: [file],
        }));
        return [...prev, ...newGroups];
      });
      setError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (loading) return;

    const droppedFiles = Array.from(e.dataTransfer.files).filter(file => {
      const isImage = file.type.startsWith('image/');
      const isPDF = file.type === 'application/pdf';
      return isImage || isPDF;
    });

    if (droppedFiles.length > 0) {
      setFileGroups(prev => {
        const newGroups = droppedFiles.map((file, index) => ({
          id: crypto.randomUUID(),
          name: `Group ${prev.length + index + 1}`,
          files: [file],
        }));
        return [...prev, ...newGroups];
      });
      setError(null);
    }
  };

  const handleFileDragStart = (groupId: string, fileIndex: number) => {
    setDraggedFile({ groupId, fileIndex });
  };

  const handleGroupDragOver = (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverGroup(targetGroupId);
  };

  const handleGroupDragLeave = () => {
    setDragOverGroup(null);
  };

  const handleGroupDrop = (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverGroup(null);

    if (!draggedFile || draggedFile.groupId === targetGroupId) {
      setDraggedFile(null);
      return;
    }

    // Move file from source group to target group
    setFileGroups(prev => {
      const sourceGroup = prev.find(g => g.id === draggedFile.groupId);
      const targetGroup = prev.find(g => g.id === targetGroupId);

      if (sourceGroup && targetGroup && sourceGroup.files[draggedFile.fileIndex]) {
        const movedFile = sourceGroup.files[draggedFile.fileIndex];

        // Create new groups array with updated files
        const updatedGroups = prev.map(group => {
          if (group.id === draggedFile.groupId) {
            // Remove file from source group
            return {
              ...group,
              files: group.files.filter((_, idx) => idx !== draggedFile.fileIndex),
            };
          } else if (group.id === targetGroupId) {
            // Add file to target group
            return {
              ...group,
              files: [...group.files, movedFile],
            };
          }
          return group;
        });

        // Remove empty groups
        return updatedGroups.filter(g => g.files.length > 0);
      }

      return prev;
    });

    setDraggedFile(null);
  };

  const handleRemoveFile = (groupId: string, fileIndex: number) => {
    setFileGroups(prev => {
      const newGroups = prev.map(group => {
        if (group.id === groupId) {
          return {
            ...group,
            files: group.files.filter((_, idx) => idx !== fileIndex),
          };
        }
        return group;
      });
      // Remove empty groups
      return newGroups.filter(g => g.files.length > 0);
    });
  };

  const handleRenameGroup = (groupId: string, newName: string) => {
    setFileGroups(prev =>
      prev.map(group =>
        group.id === groupId ? { ...group, name: newName } : group
      )
    );
  };

  const handleDeleteGroup = (groupId: string) => {
    setFileGroups(prev => prev.filter(group => group.id !== groupId));
  };

  const handleDeleteResult = (groupId: string) => {
    setGroupResults(prev =>
      prev.map((result) =>
        result.group.id === groupId ? { ...result, status: 'cancelled' as const } : result
      )
    );
  };

  const handleSavePurchaseOrder = async (groupId: string) => {
    const resultIndex = groupResults.findIndex(r => r.group.id === groupId);
    if (resultIndex === -1) return;

    const data = getEditableData(resultIndex);
    if (!data) return;

    // Validate required fields
    if (!data.supplier.name) {
      alert('Supplier name is required');
      return;
    }

    if (!data.poLines || data.poLines.length === 0) {
      alert('At least one line item is required');
      return;
    }

    setSavingIndex(resultIndex);

    try {
      // Get the files for this group
      const group = fileGroups.find(g => g.id === groupId);
      const files = group?.files || [];

      // Create FormData to include both data and files
      const formData = new FormData();
      formData.append('data', JSON.stringify(data));
      formData.append('fileCount', files.length.toString());
      files.forEach((file, index) => {
        formData.append(`file${index}`, file);
      });

      const response = await authenticatedFetch('/api/purchasing/po/save', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to save purchase order');
      }

      // Show success message
      const supplierName = data.supplier.name;
      setSuccessMessage(`Purchase order for ${supplierName} saved successfully!`);

      // Remove the file group and result after successful save
      setFileGroups(prev => prev.filter(g => g.id !== groupId));
      setGroupResults(prev => prev.filter(r => r.group.id !== groupId));

      // Auto-hide success message after 5 seconds
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save purchase order');
    } finally {
      setSavingIndex(null);
    }
  };

  const handleManualSubmit = async (data: any) => {
    setManualError(null);

    if (!data?.supplier?.name) {
      setManualError('Supplier name is required');
      return;
    }

    if (!data.poLines || data.poLines.length === 0) {
      setManualError('At least one line item is required');
      return;
    }

    setManualSaving(true);

    try {
      const response = await authenticatedFetch('/api/purchasing/po/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to save purchase order');
      }

      const supplierName = data.supplier.name;
      setSuccessMessage(`Purchase order for ${supplierName} saved successfully!`);
      setTimeout(() => setSuccessMessage(null), 5000);
      setManualFormKey(prev => prev + 1);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : 'Failed to save purchase order');
    } finally {
      setManualSaving(false);
    }
  };

  const getEditableData = (index: number): ExtractedData | undefined => {
    return editedData[index] || groupResults[index]?.extractedData;
  };

  const updateField = (resultIndex: number, field: string, value: any) => {
    const currentData = getEditableData(resultIndex);
    if (!currentData) return;

    const keys = field.split('.');
    const updated = JSON.parse(JSON.stringify(currentData));

    let obj: any = updated;
    for (let i = 0; i < keys.length - 1; i++) {
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;

    setEditedData(prev => ({ ...prev, [resultIndex]: updated }));
  };

  const updateLineItem = (resultIndex: number, lineIndex: number, field: string, value: any) => {
    const currentData = getEditableData(resultIndex);
    if (!currentData) return;

    const updated = JSON.parse(JSON.stringify(currentData));
    updated.poLines[lineIndex][field] = value;

    setEditedData(prev => ({ ...prev, [resultIndex]: updated }));
  };

  const addLineItem = (resultIndex: number) => {
    const currentData = getEditableData(resultIndex);
    if (!currentData) return;

    const updated = JSON.parse(JSON.stringify(currentData));
    updated.poLines.push({
      description: '',
      supplierSku: '',
      quantity: 0,
      unitCostExVAT: 0,
      lineTotalExVAT: 0,
      rrp: null,
    });

    setEditedData(prev => ({ ...prev, [resultIndex]: updated }));
  };

  const removeLineItem = (resultIndex: number, lineIndex: number) => {
    const currentData = getEditableData(resultIndex);
    if (!currentData) return;

    const updated = JSON.parse(JSON.stringify(currentData));
    updated.poLines.splice(lineIndex, 1);

    setEditedData(prev => ({ ...prev, [resultIndex]: updated }));
  };

  // Extract analysis logic into reusable function
  const analyzeGroup = async (groupIndex: number, group: FileGroup) => {
    // Update status to processing
    setGroupResults(prev =>
      prev.map((result) =>
        result.group.id === group.id ? { ...result, status: 'processing' as const } : result
      )
    );

    try {
      // Create form data with all files in the group
      const formData = new FormData();
      group.files.forEach((file, index) => {
        formData.append(`file${index}`, file);
      });
      formData.append('fileCount', group.files.length.toString());
      formData.append('groupName', group.name);

      // Send to extract API
      const response = await authenticatedFetch('/api/purchasing/po/extract', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Extraction failed');
      }

      // Update with extracted data
      setGroupResults(prev =>
        prev.map((result) =>
          result.group.id === group.id
            ? {
              ...result,
              status: 'extracted' as const,
              extractedData: data.data,
              duplicatesChecked: false,
            }
            : result
        )
      );

      // Check for duplicates
      try {
        // Skip duplicate check if supplier name is not available
        if (!data.data.supplier?.name || data.data.supplier.name.trim() === '') {
          console.log('Skipping duplicate check: no supplier name found');
          setGroupResults(prev =>
            prev.map((result) =>
              result.group.id === group.id
                ? { ...result, duplicatesChecked: true, duplicates: [] }
                : result
            )
          );
        } else {
          const duplicateResponse = await authenticatedFetch('/api/purchasing/po/check-duplicates', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              supplierName: data.data.supplier.name,
              invoiceNumber: data.data.purchaseOrder.invoiceNumber,
              invoiceDate: data.data.purchaseOrder.invoiceDate,
              poLines: data.data.poLines,
            }),
          });

          if (duplicateResponse.ok) {
            const duplicateData = await duplicateResponse.json();
            if (duplicateData.hasDuplicates) {
              setGroupResults(prev =>
                prev.map((result) =>
                  result.group.id === group.id
                    ? {
                      ...result,
                      duplicates: duplicateData.duplicates,
                      duplicatesChecked: true,
                    }
                    : result
                )
              );
            } else {
              setGroupResults(prev =>
                prev.map((result) =>
                  result.group.id === group.id
                    ? { ...result, duplicatesChecked: true, duplicates: [] }
                    : result
                )
              );
            }
          } else {
            const errorData = await duplicateResponse.json();
            console.error('Failed to check duplicates:', errorData.error);
            // Continue without duplicate check
            setGroupResults(prev =>
              prev.map((result) =>
                result.group.id === group.id
                  ? { ...result, duplicatesChecked: true, duplicates: [] }
                  : result
              )
            );
          }
        }
      } catch (err) {
        // Update with error
        setGroupResults(prev =>
          prev.map((result) =>
            result.group.id === group.id
              ? {
                ...result,
                status: 'error' as const,
                error: err instanceof Error ? err.message : 'An error occurred',
              }
              : result
          )
        );
      }
    } catch (err) {
      // Update with error
      setGroupResults(prev =>
        prev.map((result) =>
          result.group.id === group.id
            ? {
              ...result,
              status: 'error' as const,
              error: err instanceof Error ? err.message : 'An error occurred',
            }
            : result
        )
      );
    }
  };

  // Analyze a specific group
  const handleAnalyzeGroup = async (groupId: string) => {
    const groupIndex = fileGroups.findIndex(g => g.id === groupId);
    if (groupIndex === -1) return;

    const group = fileGroups[groupIndex];

    // Initialize result if not exists
    setGroupResults(prev => {
      const existing = prev.find(r => r.group.id === groupId);
      if (!existing) {
        return [...prev, { group, status: 'pending' as const }];
      }
      return prev;
    });

    await analyzeGroup(groupIndex, group);
  };

  // Analyze all groups
  const handleAnalyzeAll = async () => {
    if (fileGroups.length === 0) {
      setError('Please select at least one file');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    // Initialize results for all groups
    const initialResults: GroupResult[] = fileGroups.map(group => ({
      group,
      status: 'pending' as const,
    }));
    setGroupResults(initialResults);

    // Process groups one by one
    for (let i = 0; i < fileGroups.length; i++) {
      await analyzeGroup(i, fileGroups[i]);
    }

    setLoading(false);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await handleAnalyzeAll();
  };

  return (
    <div className="h-screen flex flex-col bg-[#f9f9f8] dark:bg-stone-900 overflow-hidden">
      {/* Sticky header */}
      <div className="flex-none px-3 sm:px-4 lg:px-6 pt-4 sm:pt-6 pb-3 space-y-4 border-b border-stone-200 dark:border-stone-800 bg-[#f9f9f8] dark:bg-stone-900">
        <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-stone-900 dark:text-stone-100">Purchase Order Import</h1>
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <div className="inline-flex items-center rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-0.5">
              <button
                type="button"
                onClick={() => setMode('import')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'import'
                    ? 'bg-amber-600 text-white'
                    : 'text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700'
                  }`}
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setMode('manual')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'manual'
                    ? 'bg-amber-600 text-white'
                    : 'text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700'
                  }`}
              >
                Manual
              </button>
            </div>
            <button
              onClick={navigateToView}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-stone-200 dark:border-stone-700 text-sm font-medium rounded-md text-stone-700 dark:text-stone-300 bg-white dark:bg-stone-800 hover:bg-stone-100 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-600 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              View Orders
            </button>
          </div>
        </div>
      </div>
      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6">
        {mode === 'import' && (
          <>
            {/* Upload Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-stone-800 dark:text-stone-200 mb-3">
                  Upload Invoice Files (PNG, JPG, or PDF)
                </label>

                {/* Drag and Drop Zone */}
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`relative border-2 border-dashed rounded-lg transition-all ${isDragging
                      ? 'border-amber-600 bg-stone-100 dark:bg-stone-700'
                      : 'border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 hover:border-stone-300 dark:hover:border-stone-600'
                    } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <input
                    id="file-upload"
                    type="file"
                    accept="image/*,.png,.jpg,.jpeg,.pdf,application/pdf"
                    onChange={handleFileChange}
                    disabled={loading}
                    multiple
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                  />

                  <div className="py-12 px-6 text-center">
                    <svg
                      className={`mx-auto h-16 w-16 ${isDragging ? 'text-amber-600' : 'text-stone-400'}`}
                      stroke="currentColor"
                      fill="none"
                      viewBox="0 0 48 48"
                      aria-hidden="true"
                    >
                      <path
                        d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <div className="mt-4 flex text-sm leading-6 text-stone-600 dark:text-stone-400 justify-center">
                      <span className="font-semibold text-amber-600 hover:text-amber-700">
                        Click to upload
                      </span>
                      <span className="pl-1">or drag and drop</span>
                    </div>
                    <p className="text-xs leading-5 text-stone-500 dark:text-stone-400 mt-2">
                      PNG, JPG, or PDF files
                    </p>
                  </div>
                </div>
              </div>

              {/* File Groups */}
              {fileGroups.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-stone-900 dark:text-stone-100">
                      File Groups ({fileGroups.length})
                    </h3>
                    {!loading && (
                      <button
                        type="button"
                        onClick={() => setFileGroups([])}
                        className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                      >
                        Clear All
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                    {fileGroups.map((group) => {
                      const groupResult = groupResults.find(r => r.group.id === group.id);
                      const isProcessing = groupResult?.status === 'processing';
                      const isExtracted = groupResult?.status === 'extracted';
                      const hasError = groupResult?.status === 'error';

                      return (
                        <div
                          key={group.id}
                          onDragOver={(e) => handleGroupDragOver(e, group.id)}
                          onDragLeave={handleGroupDragLeave}
                          onDrop={(e) => handleGroupDrop(e, group.id)}
                          className={`border-2 rounded-lg p-4 transition-all relative ${dragOverGroup === group.id
                              ? 'border-amber-600 bg-stone-100 dark:bg-stone-700'
                              : isExtracted
                                ? 'border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800'
                                : hasError
                                  ? 'border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800'
                                  : isProcessing
                                    ? 'border-amber-500 bg-stone-100 dark:bg-stone-700'
                                    : 'border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800'
                            }`}
                        >
                          {/* Status Badge */}
                          {isExtracted && (
                            <div className="absolute top-2 right-2">
                              <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </div>
                          )}
                          {hasError && (
                            <div className="absolute top-2 right-2">
                              <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </div>
                          )}
                          {/* Group Header */}
                          <div className="mb-3">
                            <input
                              type="text"
                              value={group.name}
                              onChange={(e) => handleRenameGroup(group.id, e.target.value)}
                              disabled={loading}
                              className="w-full text-sm font-medium text-stone-900 dark:text-stone-100 bg-transparent border-b border-transparent hover:border-stone-200 dark:hover:border-stone-600 focus:border-amber-600 focus:outline-none px-1 py-1"
                            />
                            <div className="flex items-center justify-between mt-1">
                              <p className="text-xs text-stone-500 dark:text-stone-400">
                                {group.files.length} file{group.files.length !== 1 ? 's' : ''}
                              </p>
                              <button
                                type="button"
                                onClick={() => handleAnalyzeGroup(group.id)}
                                disabled={loading || groupResults.some(r => r.group.id === group.id && (r.status === 'processing' || r.status === 'extracted' || r.status === 'success'))}
                                className="text-xs px-2 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >
                                {groupResults.find(r => r.group.id === group.id)?.status === 'processing' ? 'Analyzing...' : 'Analyze'}
                              </button>
                            </div>
                          </div>

                          {/* Files in Group */}
                          <div className="space-y-2">
                            {group.files.filter(f => f).map((file, fileIndex) => (
                              <div
                                key={fileIndex}
                                draggable={!loading}
                                onDragStart={() => handleFileDragStart(group.id, fileIndex)}
                                className={`flex items-center justify-between p-2 bg-[#f9f9f8] dark:bg-stone-900 rounded border border-stone-200 dark:border-stone-700 ${!loading ? 'cursor-move hover:bg-white' : ''
                                  }`}
                              >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <svg className="w-4 h-4 text-stone-400 dark:text-stone-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                  <span className="text-xs text-stone-600 dark:text-stone-400 truncate">{file.name}</span>
                                </div>
                                {!loading && (
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveFile(group.id, fileIndex)}
                                    className="text-amber-600 hover:text-amber-700 p-1 rounded hover:bg-stone-100 transition-colors flex-shrink-0"
                                  >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>

                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={fileGroups.length === 0 || loading}
                className="w-full bg-amber-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="flex items-center justify-center">
                    <svg
                      className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Processing...
                  </span>
                ) : (
                  `Analyze All ${fileGroups.length} Group${fileGroups.length !== 1 ? 's' : ''}`
                )}
              </button>
            </form>

            {/* Success Message Display */}
            {successMessage && (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 mb-6">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg
                      className="h-5 w-5 text-green-600"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3 flex-1">
                    <h3 className="text-sm font-medium text-green-800">Success</h3>
                    <p className="text-sm text-green-700 mt-1">{successMessage}</p>
                  </div>
                  <button
                    onClick={() => setSuccessMessage(null)}
                    className="flex-shrink-0 ml-3 text-green-600 hover:text-green-600"
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg
                      className="h-5 w-5 text-red-600"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">Error</h3>
                    <p className="text-sm text-red-700 mt-1">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Results Display */}
            {groupResults.some(r => r.status !== 'success' && r.status !== 'cancelled') && (
              <div className="space-y-4">
                {groupResults.map((result, index) => {
                  // Don't display groups that have been accepted or cancelled
                  if (result.status === 'success' || result.status === 'cancelled') {
                    return null;
                  }

                  return (
                    <div key={index} className="bg-white dark:bg-stone-800 rounded-lg shadow-md p-6 border border-stone-200 dark:border-stone-700">
                      <div className="flex items-center gap-2 mb-4">
                        {result.status === 'processing' && (
                          <svg className="animate-spin h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        )}
                        {result.status === 'extracted' && (
                          <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                        {result.status === 'error' && (
                          <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                        <h3 className="text-lg font-semibold text-stone-900 dark:text-stone-100">{result.group.name}</h3>
                        <span className="text-sm text-stone-500 dark:text-stone-400">
                          ({result.group.files.length} file{result.group.files.length !== 1 ? 's' : ''})
                        </span>
                      </div>

                      {result.status === 'processing' && (
                        <p className="text-sm text-stone-600 dark:text-stone-400">Analyzing files...</p>
                      )}

                      {result.status === 'error' && (
                        <div className="text-sm text-red-600">
                          <p className="font-medium">Error:</p>
                          <p>{result.error}</p>
                        </div>
                      )}

                      {result.status === 'extracted' && result.extractedData && (
                        <div className="space-y-6">
                          {/* Duplicate Warning */}
                          {result.duplicates && result.duplicates.length > 0 && !dismissedDuplicates.has(result.group.id) && (
                            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                              <div className="flex items-start">
                                <div className="flex-shrink-0">
                                  <svg className="h-5 w-5 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                  </svg>
                                </div>
                                <div className="ml-3 flex-1">
                                  <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-500">Possible Duplicate Order Detected</h3>
                                  <div className="mt-2 text-sm text-yellow-700 dark:text-yellow-400">
                                    <p className="mb-2">This order may already exist in the system:</p>
                                    {result.duplicates.map((dup, dupIdx) => (
                                      <div key={dupIdx} className="mb-2 p-2 bg-yellow-100 dark:bg-yellow-900/40 rounded border border-yellow-300 dark:border-yellow-700">
                                        <p className="font-medium">
                                          {dup.supplierName} - {dup.invoiceNumber || 'No Invoice #'}
                                          {dup.invoiceDate && ` (${new Date(dup.invoiceDate).toLocaleDateString()})`}
                                        </p>
                                        <p className="text-xs mt-1">
                                          Match Score: {dup.matchScore}% | {dup.matchReasons.join(', ')}
                                        </p>
                                        <p className="text-xs text-yellow-600">
                                          Created: {new Date(dup.createdAt).toLocaleString()}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                                <button
                                  onClick={() => setDismissedDuplicates(prev => new Set(prev).add(result.group.id))}
                                  className="flex-shrink-0 ml-3 text-yellow-600 hover:text-yellow-700 transition-colors"
                                  title="Dismiss warning"
                                >
                                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Supplier Information */}
                          <div>
                            <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-3">Supplier Information</h4>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Supplier Name *</label>
                                <input
                                  type="text"
                                  value={getEditableData(index)?.supplier.name || ''}
                                  onChange={(e) => updateField(index, 'supplier.name', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Email</label>
                                <input
                                  type="email"
                                  value={getEditableData(index)?.supplier.email || ''}
                                  onChange={(e) => updateField(index, 'supplier.email', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Phone</label>
                                <input
                                  type="text"
                                  value={getEditableData(index)?.supplier.phone || ''}
                                  onChange={(e) => updateField(index, 'supplier.phone', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">VAT Number</label>
                                <input
                                  type="text"
                                  value={getEditableData(index)?.supplier.vatNumber || ''}
                                  onChange={(e) => updateField(index, 'supplier.vatNumber', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div className="col-span-2">
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Address</label>
                                <textarea
                                  value={getEditableData(index)?.supplier.address || ''}
                                  onChange={(e) => updateField(index, 'supplier.address', e.target.value)}
                                  rows={2}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                            </div>
                          </div>

                          {/* Purchase Order Information */}
                          <div>
                            <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-3">Purchase Order Details</h4>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Invoice Number</label>
                                <input
                                  type="text"
                                  value={getEditableData(index)?.purchaseOrder.invoiceNumber || ''}
                                  onChange={(e) => updateField(index, 'purchaseOrder.invoiceNumber', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Invoice Date</label>
                                <input
                                  type="date"
                                  value={getEditableData(index)?.purchaseOrder.invoiceDate || ''}
                                  onChange={(e) => updateField(index, 'purchaseOrder.invoiceDate', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Currency</label>
                                <input
                                  type="text"
                                  value={getEditableData(index)?.purchaseOrder.originalCurrency || ''}
                                  onChange={(e) => updateField(index, 'purchaseOrder.originalCurrency', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Payment Terms</label>
                                <input
                                  type="text"
                                  value={getEditableData(index)?.purchaseOrder.paymentTerms || ''}
                                  onChange={(e) => updateField(index, 'purchaseOrder.paymentTerms', e.target.value)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                            </div>

                            {/* Notes Field */}
                            <div className="mt-4">
                              <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Notes</label>
                              <textarea
                                value={getEditableData(index)?.notes || ''}
                                onChange={(e) => updateField(index, 'notes', e.target.value)}
                                rows={3}
                                placeholder="Add notes or special instructions for receiving and booking in stock"
                                className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                              />
                            </div>
                          </div>

                          {/* Line Items Table */}
                          <div>
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Line Items</h4>
                              <button
                                type="button"
                                onClick={() => addLineItem(index)}
                                className="inline-flex items-center px-3 py-1 text-xs font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700"
                              >
                                <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                Add Line
                              </button>
                            </div>

                            <div className="overflow-x-auto border border-stone-200 dark:border-stone-700 rounded-lg">
                              <table className="min-w-full divide-y divide-stone-200 dark:divide-stone-700">
                                <thead className="bg-[#f9f9f8] dark:bg-stone-900">
                                  <tr>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-stone-600 dark:text-stone-400 uppercase">Description</th>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-stone-600 dark:text-stone-400 uppercase">SKU</th>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-stone-600 dark:text-stone-400 uppercase w-24">Qty</th>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-stone-600 dark:text-stone-400 uppercase w-32">Unit Price</th>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-stone-600 dark:text-stone-400 uppercase w-32">Line Total</th>
                                    <th className="px-3 py-2 text-left text-xs font-semibold text-stone-600 dark:text-stone-400 uppercase w-32">RRP</th>
                                    <th className="px-3 py-2 w-10"></th>
                                  </tr>
                                </thead>
                                <tbody className="bg-white dark:bg-stone-800 divide-y divide-stone-200 dark:divide-stone-700">
                                  {getEditableData(index)?.poLines.map((line, lineIndex) => (
                                    <tr key={lineIndex}>
                                      <td className="px-3 py-2">
                                        <input
                                          type="text"
                                          value={line.description}
                                          onChange={(e) => updateLineItem(index, lineIndex, 'description', e.target.value)}
                                          className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          type="text"
                                          value={line.supplierSku || ''}
                                          onChange={(e) => updateLineItem(index, lineIndex, 'supplierSku', e.target.value)}
                                          className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          type="number"
                                          value={line.quantity}
                                          onChange={(e) => updateLineItem(index, lineIndex, 'quantity', parseFloat(e.target.value) || 0)}
                                          className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          type="number"
                                          step="0.01"
                                          value={line.unitCostExVAT}
                                          onChange={(e) => updateLineItem(index, lineIndex, 'unitCostExVAT', parseFloat(e.target.value) || 0)}
                                          className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          type="number"
                                          step="0.01"
                                          value={line.lineTotalExVAT}
                                          onChange={(e) => updateLineItem(index, lineIndex, 'lineTotalExVAT', parseFloat(e.target.value) || 0)}
                                          className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <input
                                          type="number"
                                          step="0.01"
                                          value={line.rrp || ''}
                                          onChange={(e) => updateLineItem(index, lineIndex, 'rrp', parseFloat(e.target.value) || null)}
                                          placeholder="Optional"
                                          className="w-full px-2 py-1 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-amber-600"
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <button
                                          type="button"
                                          onClick={() => removeLineItem(index, lineIndex)}
                                          className="text-amber-600 hover:text-amber-700"
                                        >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                          </svg>
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>

                          {/* Totals */}
                          <div className="bg-[#f9f9f8] dark:bg-stone-900 rounded-lg p-4 border border-stone-200 dark:border-stone-700">
                            <h4 className="text-sm font-semibold text-stone-900 dark:text-stone-100 mb-3">Totals</h4>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Subtotal (ex VAT) - GBP</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={getEditableData(index)?.totals.subtotal || 0}
                                  onChange={(e) => updateField(index, 'totals.subtotal', parseFloat(e.target.value) || 0)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Extras (Shipping, etc.) - GBP</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={getEditableData(index)?.totals.extras || 0}
                                  onChange={(e) => updateField(index, 'totals.extras', parseFloat(e.target.value) || 0)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">VAT - GBP</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={getEditableData(index)?.totals.vat || 0}
                                  onChange={(e) => updateField(index, 'totals.vat', parseFloat(e.target.value) || 0)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-stone-600 dark:text-stone-400 mb-1">Total - GBP</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={getEditableData(index)?.totals.total || 0}
                                  onChange={(e) => updateField(index, 'totals.total', parseFloat(e.target.value) || 0)}
                                  className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-[#f9f9f8] dark:bg-stone-900 rounded-md text-sm text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                                />
                              </div>
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => handleDeleteResult(result.group.id)}
                              className="px-6 py-2 bg-stone-100 dark:bg-stone-700 text-stone-900 dark:text-stone-100 rounded-md hover:bg-stone-200 dark:hover:bg-stone-600 focus:outline-none focus:ring-2 focus:ring-amber-600 font-medium"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSavePurchaseOrder(result.group.id)}
                              disabled={savingIndex === index}
                              className="px-6 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingIndex === index ? 'Saving...' : 'Save Purchase Order'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {mode === 'manual' && (
          <div className="bg-white dark:bg-stone-800 rounded-lg shadow-md p-6 mb-6 border border-stone-200 dark:border-stone-700">
            <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2">
              Manual Purchase Order Entry
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">
              Enter purchase order details manually when you do not have an invoice file to upload.
            </p>
            {successMessage && (
              <div className="mb-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg
                      className="h-5 w-5 text-green-600"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3 flex-1">
                    <h3 className="text-sm font-medium text-green-800">Success</h3>
                    <p className="text-sm text-green-700 mt-1">{successMessage}</p>
                  </div>
                  <button
                    onClick={() => setSuccessMessage(null)}
                    className="flex-shrink-0 ml-3 text-green-600 hover:text-green-600"
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            <PurchaseOrderForm
              key={manualFormKey}
              initialData={{
                supplier: {},
                purchaseOrder: {},
                poLines: [
                  {
                    description: '',
                    supplierSku: '',
                    quantity: 1,
                    unitCostExVAT: 0,
                    lineTotalExVAT: 0,
                  },
                ],
                totals: {},
              }}
              onSubmit={handleManualSubmit}
              title="Purchase order details"
              description="Fill in the supplier, invoice, and line item details. All prices should be entered in GBP."
              submitButtonText="Save Purchase Order"
              loading={manualSaving}
              error={manualError || undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function ImportPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#f9f9f8] dark:bg-stone-900 flex items-center justify-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-amber-600"></div>
        </div>
      }
    >
      <ImportPageContent />
    </Suspense>
  );
}
