import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation, useParams } from 'react-router-dom';
import Layout from './components/Layout';
import BoardPage from './components/BoardPage';
import DocumentationDetail from './components/DocumentationDetail';
import DecisionDetail from './components/DecisionDetail';
import TaskList from './components/TaskList';
import Statistics from './components/Statistics';
import { SettingsPage } from './components/SettingsPage';
import MilestonesPage from './components/MilestonesPage';
import MyWorkPage from './components/MyWorkPage';
import TeamPage from './components/TeamPage';
import TaskDetailsModal from './components/TaskDetailsModal';
import InitializationScreen from './components/InitializationScreen';
import { SuccessToast } from './components/SuccessToast';
import { ThemeProvider } from './contexts/ThemeContext';
import {
	type Decision,
	type DecisionSearchResult,
	type Document,
	type DocumentSearchResult,
	type BacklogConfig,
	type Milestone,
	type SearchResult,
	type Task,
	type TaskSearchResult,
} from '../types';
import { apiClient } from './lib/api';
import { useHealthCheckContext } from './contexts/HealthCheckContext';
import { useAuth } from './contexts/AuthContext';
import LoginPage from './components/LoginPage';
import { getWebVersion } from './utils/version';
import { buildMilestoneAliasMap, canonicalizeMilestoneValue, collectArchivedMilestoneKeys, collectMilestoneIds, milestoneKey } from './utils/milestones';

function TaskRoute({
  tasks,
  isLoading,
  onOpen,
}: {
  tasks: Task[];
  isLoading: boolean;
  onOpen: (task: Task) => void;
}) {
  const { taskId } = useParams<{ taskId: string }>();
  useEffect(() => {
    if (isLoading) return;
    const task = tasks.find((t) => t.id === taskId);
    if (task) onOpen(task);
  }, [taskId, tasks, isLoading, onOpen]);
  return null;
}

function AppRoutes() {
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [pendingParentTaskId, setPendingParentTaskId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);
  const [projectName, setProjectName] = useState<string>('');
  const [config, setConfig] = useState<BacklogConfig | null>(null);
  const [milestones, setMilestones] = useState<string[]>([]);
  const [milestoneEntities, setMilestoneEntities] = useState<Milestone[]>([]);
  const [archivedMilestones, setArchivedMilestones] = useState<Milestone[]>([]);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [taskConfirmation, setTaskConfirmation] = useState<{task: Task} | null>(null);

  // Initialization state
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);

  // Centralized data state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Board and task list only show top-level tasks (no subtasks)
  const topLevelTasks = useMemo(() => tasks.filter(t => !t.parentTaskId), [tasks]);

  const { isOnline, setMessageHandler } = useHealthCheckContext();
  const previousOnlineRef = useRef<boolean | null>(null);
  const hasBeenRunningRef = useRef(false);

  const navigate = useNavigate();
  const location = useLocation();

  // Set version data attribute on body
  React.useEffect(() => {
    getWebVersion().then(version => {
      if (version) {
        document.body.setAttribute('data-version', `Backlog.md - v${version}`);
      }
    });
  }, []);

  // Check initialization status on mount
  React.useEffect(() => {
    const checkInitStatus = async () => {
      try {
        const status = await apiClient.checkStatus();
        setIsInitialized(status.initialized);
      } catch (error) {
        // If we can't check status, assume not initialized
        console.error('Failed to check initialization status:', error);
        setIsInitialized(false);
      }
    };
    checkInitStatus();
  }, []);

  const handleInitialized = useCallback(() => {
    setIsInitialized(true);
  }, []);

  const applySearchResults = useCallback((
    results: SearchResult[],
    archivedMilestoneKeys?: Set<string>,
    milestoneAliases?: Map<string, string>,
  ) => {
    const taskResults = results.filter((result): result is TaskSearchResult => result.type === 'task');
    const documentResults = results.filter((result): result is DocumentSearchResult => result.type === 'document');
    const decisionResults = results.filter((result): result is DecisionSearchResult => result.type === 'decision');

    const tasksList = taskResults.map((result) => result.task);
    const aliases = milestoneAliases ?? new Map<string, string>();
    const normalizedTasks =
      archivedMilestoneKeys && archivedMilestoneKeys.size > 0
        ? tasksList.map((task) => {
            const canonicalMilestone = canonicalizeMilestoneValue(task.milestone, aliases);
            const key = milestoneKey(canonicalMilestone);
            if (!key || !archivedMilestoneKeys.has(key)) {
              if (task.milestone === canonicalMilestone) {
                return task;
              }
              return { ...task, milestone: canonicalMilestone || undefined };
            }
            return { ...task, milestone: undefined };
          })
        : tasksList.map((task) => {
            const canonicalMilestone = canonicalizeMilestoneValue(task.milestone, aliases);
            if (task.milestone === canonicalMilestone) {
              return task;
            }
            return { ...task, milestone: canonicalMilestone || undefined };
          });
    const docsList = documentResults.map((result) => result.document);
    const decisionsList = decisionResults.map((result) => result.decision);

    setTasks(normalizedTasks);
    setDocs(docsList);
    setDecisions(decisionsList);

    return { tasks: normalizedTasks, docs: docsList, decisions: decisionsList };
  }, []);

  const loadAllData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [statusesData, configData, searchResults, milestonesData, archivedMilestonesData] = await Promise.all([
        apiClient.fetchStatuses(),
        apiClient.fetchConfig(),
        apiClient.search(),
        apiClient.fetchMilestones(),
        apiClient.fetchArchivedMilestones(),
      ]);

      const archivedKeys = new Set(collectArchivedMilestoneKeys(archivedMilestonesData, milestonesData));
      const milestoneAliases = buildMilestoneAliasMap(milestonesData, archivedMilestonesData);
      const { tasks: tasksList } = applySearchResults(searchResults, archivedKeys, milestoneAliases);

      setStatuses(statusesData);
      setProjectName(configData.projectName);
      setAvailableLabels(configData.labels || []);
      setConfig(configData);
      setMilestoneEntities(milestonesData);
      setArchivedMilestones(archivedMilestonesData);
      setMilestones(
        collectMilestoneIds(tasksList, milestonesData, archivedMilestonesData).filter(
          (milestone) => !archivedKeys.has(milestoneKey(milestone)),
        ),
      );
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [applySearchResults]);

  React.useEffect(() => {
    // Only load data when initialized
    if (isInitialized === true) {
      loadAllData();
    }
  }, [loadAllData, isInitialized]);

  // Reload data when connection is restored
  React.useEffect(() => {
    if (isOnline && previousOnlineRef.current === false) {
      // Connection restored, reload data
      const loadData = async () => {
        try {
          const [results, milestonesData, archivedMilestonesData] = await Promise.all([
            apiClient.search(),
            apiClient.fetchMilestones(),
            apiClient.fetchArchivedMilestones(),
          ]);
          const archivedKeys = new Set(collectArchivedMilestoneKeys(archivedMilestonesData, milestonesData));
          const milestoneAliases = buildMilestoneAliasMap(milestonesData, archivedMilestonesData);
          const { tasks: tasksList } = applySearchResults(results, archivedKeys, milestoneAliases);
          setMilestoneEntities(milestonesData);
          setArchivedMilestones(archivedMilestonesData);
          setMilestones(
            collectMilestoneIds(tasksList, milestonesData, archivedMilestonesData).filter(
              (milestone) => !archivedKeys.has(milestoneKey(milestone)),
            ),
          );
        } catch (error) {
          console.error('Failed to reload data:', error);
        }
      };
      loadData();
    }
  }, [applySearchResults, isOnline]);

  // Update document title when project name changes
  React.useEffect(() => {
    if (projectName) {
      document.title = `${projectName} - Task Management`;
    }
  }, [projectName]);

  // Mark that we've been running after initial load
  useEffect(() => {
    const timer = setTimeout(() => {
      hasBeenRunningRef.current = true;
    }, 2000); // Wait 2 seconds after page load
    return () => clearTimeout(timer);
  }, []);

  // Show success toast when connection is restored
  useEffect(() => {
    // Only show toast if:
    // 1. We went from offline to online AND
    // 2. We've been running for a while (not initial page load)
    if (isOnline && previousOnlineRef.current === false && hasBeenRunningRef.current) {
      setShowSuccessToast(true);
      // Auto-dismiss after 4 seconds
      const timer = setTimeout(() => {
        setShowSuccessToast(false);
      }, 4000);
      return () => clearTimeout(timer);
    }

    // Update the ref for next time
    previousOnlineRef.current = isOnline;
  }, [isOnline]);

  const handleNewTask = () => {
    setEditingTask(null);
    setShowModal(true);
  };

  const handleOpenTask = useCallback((task: Task) => {
    setEditingTask(task);
    setShowModal(true);
  }, []);

  const handleAddSubtask = useCallback((parentId: string) => {
    setPendingParentTaskId(parentId);
    setEditingTask(null);
    setShowModal(true);
  }, []);

  const handleOpenParentTask = useCallback((parentId: string) => {
    const parent = tasks.find((t) => t.id === parentId);
    if (parent) {
      setPendingParentTaskId(null);
      handleOpenTask(parent);
    }
  }, [tasks, handleOpenTask]);

  const handleEditTask = (task: Task) => {
    navigate(`/tasks/${task.id}`);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingTask(null);
    setPendingParentTaskId(null);
    // Capture whether there's history to go back to before any navigation fires.
    const hadHistory = location.key !== 'default';
    // Defer the back-navigation so that any synchronous Link navigation inside
    // the modal (e.g. assignee links) fires first. If the Link already navigated
    // away from the task URL, we skip navigate(-1) entirely — otherwise it would
    // fire asynchronously via history.go(-1) and undo the Link's navigation.
    setTimeout(() => {
      if (!window.location.pathname.match(/^\/(tasks|team)\/.+/)) return;
      if (hadHistory) {
        navigate(-1);
      } else {
        navigate('/tasks');
      }
    }, 0);
  };

  const handleOpenTaskFromRoute = useCallback((task: Task) => {
    setEditingTask(task);
    setShowModal(true);
  }, []);

  const refreshData = useCallback(async () => {
    await loadAllData();
  }, [loadAllData]);

  // Sync editingTask with refreshed tasks data to prevent stale state
  useEffect(() => {
    if (editingTask && showModal) {
      const updatedTask = tasks.find(t => t.id === editingTask.id);
      if (updatedTask && updatedTask !== editingTask) {
        setEditingTask(updatedTask);
      }
    }
  }, [tasks, editingTask, showModal]);

  useEffect(() => {
    setMessageHandler((data) => {
      if (data === "tasks-updated") {
        refreshData();
      } else if (data === "config-updated") {
        loadAllData();
      }
    });
  }, [setMessageHandler, refreshData, loadAllData]);

  const handleSubmitTask = async (taskData: Partial<Task>): Promise<void | boolean> => {
    // Don't catch errors here - let TaskDetailsModal handle them
    const capturedParentId = pendingParentTaskId;

    if (editingTask) {
      await apiClient.updateTask(editingTask.id, taskData);
      handleCloseModal();
      await refreshData();
      return;
    }

    // Create mode
    const createdTask = await apiClient.createTask(
      (capturedParentId ? { ...taskData, parentTaskId: capturedParentId } : taskData) as Omit<Task, "id" | "createdDate">
    );

    // Show task creation confirmation
    setTaskConfirmation({ task: createdTask });
    setTimeout(() => { setTaskConfirmation(null); }, 4000);

    if (capturedParentId) {
      // Subtask created: navigate back to the parent task instead of closing
      setPendingParentTaskId(null);
      const freshParent = await apiClient.fetchTask(capturedParentId);
      await refreshData();
      if (freshParent) {
        setEditingTask(freshParent); // modal transitions to parent task preview
        return false; // tell handleSave: do NOT call onClose()
      }
    }

    setEditingTask(createdTask);
    await refreshData();
    return false; // tell handleSave: do NOT call onClose(), modal transitions to preview
  };

  const handleArchiveTask = async (taskId: string) => {
    try {
      await apiClient.archiveTask(taskId);
      handleCloseModal();
      await refreshData();
    } catch (error) {
      console.error('Failed to archive task:', error);
    }
  };

  const { user, isLoading: authLoading, isAuthEnabled, clientId } = useAuth();

  // Auth gate - show login if auth is enabled but user not authenticated
  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (isAuthEnabled && !user && clientId) {
    return <LoginPage clientId={clientId} />;
  }

  // Show loading state while checking initialization
  if (isInitialized === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-lg text-gray-600 dark:text-gray-300">Loading...</div>
      </div>
    );
  }

  // Show initialization screen if not initialized
  if (isInitialized === false) {
    return <InitializationScreen onInitialized={handleInitialized} />;
  }

  return (
    <>
      <Routes>
          <Route
          path="/"
          element={
            <Layout
              projectName={projectName}
              showSuccessToast={showSuccessToast}
              onDismissToast={() => setShowSuccessToast(false)}
              tasks={tasks}
              docs={docs}
              decisions={decisions}
              isLoading={isLoading}
              onRefreshData={refreshData}
            />
          }
        >
          <Route
            index
            element={
              <BoardPage
                onEditTask={handleEditTask}
                onNewTask={handleNewTask}
              tasks={topLevelTasks}
              onRefreshData={refreshData}
              statuses={statuses}
              milestones={milestones}
              milestoneEntities={milestoneEntities}
              archivedMilestones={archivedMilestones}
              isLoading={isLoading}
            />
          }
        />
          <Route
            path="tasks"
            element={
	                <TaskList
	                  onEditTask={handleEditTask}
	                  onNewTask={handleNewTask}
	                  tasks={topLevelTasks}
	                  availableStatuses={statuses}
	                  availableLabels={availableLabels}
	                  availableMilestones={milestones}
	                  milestoneEntities={milestoneEntities}
	                  archivedMilestones={archivedMilestones}
	                  onRefreshData={refreshData}
	                />
	              }
	            />
          <Route
            path="tasks/:taskId"
            element={
              <TaskRoute
                tasks={tasks}
                isLoading={isLoading}
                onOpen={handleOpenTaskFromRoute}
              />
            }
          />
          <Route
            path="my-work"
            element={
              <MyWorkPage
                tasks={tasks}
                milestoneEntities={milestoneEntities}
                onEditTask={handleEditTask}
              />
            }
          />
          <Route
            path="team"
            element={
              <TeamPage
                tasks={tasks}
                milestoneEntities={milestoneEntities}
                onEditTask={handleEditTask}
              />
            }
          />
          <Route
            path="team/:taskId"
            element={
              <TaskRoute
                tasks={tasks}
                isLoading={isLoading}
                onOpen={handleOpenTaskFromRoute}
              />
            }
          />
          <Route
            path="milestones"
            element={
            <MilestonesPage
              tasks={tasks}
              statuses={statuses}
              milestoneEntities={milestoneEntities}
              archivedMilestones={archivedMilestones}
              onEditTask={handleEditTask}
              onRefreshData={refreshData}
            />
          }
        />
          <Route
            path="milestones/:milestoneId"
            element={
              <MilestonesPage
                tasks={tasks}
                statuses={statuses}
                milestoneEntities={milestoneEntities}
                archivedMilestones={archivedMilestones}
                onEditTask={handleEditTask}
                onRefreshData={refreshData}
              />
            }
          />
          <Route path="documentation" element={<DocumentationDetail docs={docs} onRefreshData={refreshData} />} />
          <Route path="documentation/:id" element={<DocumentationDetail docs={docs} onRefreshData={refreshData} />} />
          <Route path="documentation/:id/:title" element={<DocumentationDetail docs={docs} onRefreshData={refreshData} />} />
          <Route path="decisions" element={<DecisionDetail decisions={decisions} onRefreshData={refreshData} />} />
          <Route path="decisions/:id" element={<DecisionDetail decisions={decisions} onRefreshData={refreshData} />} />
          <Route path="decisions/:id/:title" element={<DecisionDetail decisions={decisions} onRefreshData={refreshData} />} />
          <Route path="statistics" element={<Statistics tasks={tasks} isLoading={isLoading} onEditTask={handleEditTask} projectName={projectName} />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>

      <TaskDetailsModal
        task={editingTask || undefined}
        isOpen={showModal}
        onClose={handleCloseModal}
        onSaved={refreshData}
        onSubmit={handleSubmitTask}
        onArchive={editingTask ? () => handleArchiveTask(editingTask.id) : undefined}
        availableStatuses={statuses}
        availableMilestones={milestones}
        milestoneEntities={milestoneEntities}
        archivedMilestoneEntities={archivedMilestones}
        onOpenTask={handleOpenTask}
        onAddSubtask={handleAddSubtask}
        onOpenParentTask={handleOpenParentTask}
        parentTaskId={pendingParentTaskId ?? undefined}
      />

      {/* Task Creation Confirmation Toast */}
      {taskConfirmation && (
        <SuccessToast
          message={`Task "${taskConfirmation.task.title}" created successfully! (${taskConfirmation.task.id.replace('task-', '')})`}
          onDismiss={() => setTaskConfirmation(null)}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      )}
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ThemeProvider>
  );
}
